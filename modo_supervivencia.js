// =====================================================================
// MODO SUPERVIVENCIA (2 JUGADORES) — Mapa compartido, pantalla dividida online
// =====================================================================
// Este módulo sigue EXACTAMENTE las mismas convenciones que ya usa tu
// archivo (colección Firestore por partida + matchmaking transaccional +
// tick de posición + interpolación en cliente), tal como está implementado
// en "MODO_2VS2" / "MODO_SURVIVAL" (líneas ~2708-3060 de tu HTML). Se
// integra como una tercera colección independiente: "survivalMatches".
//
// Variables que este módulo ASUME que ya existen en tu <script> principal:
//   fb (via window.firebaseReady), currentUser, DEVICE_TYPE, canvas, ctx,
//   cssW, cssH, player, obstacles, clock, gameState, score, lives,
//   resetGame(), escapeHtml(), roomModalBody, roomModal, statusMsg,
//   updateControlsHint(), START_LIVES, keys, lastShotAt, SHOT_POSE_DURATION
//
// Cómo integrarlo (resumen al final del archivo):
//   1) Pega todo este bloque dentro de tu <script> principal (después de
//      la sección de PARTIDA RÁPIDA existente).
//   2) Añade el botón del modo en renderRoomMenu() (ver abajo).
//   3) En tu función loop(time), añade las 3 llamadas marcadas con "★".
//   4) En loseLife() / donde detectas colisión con un obstáculo, añade la
//      llamada marcada con "★★" para reportar el golpe al equipo.
// =====================================================================

// ---------------------------------------------------------------------
// 1) PRNG DETERMINISTA (mulberry32)
// ---------------------------------------------------------------------
// Ambos clientes reciben el MISMO número entero (seed) desde Firestore y
// generan su propia secuencia de obstáculos localmente con este generador.
// Como mulberry32 es puramente matemático (sin Math.random()), produce
// exactamente la misma secuencia de números en cualquier dispositivo.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; // [0,1)
  };
}

// ---------------------------------------------------------------------
// 2) CONFIGURACIÓN
// ---------------------------------------------------------------------
const SV_TICK_MS       = 75;   // envío de posición: ~13/s (dentro de 10-15/s pedido)
const SV_INTERP_MS     = 120;  // ventana de interpolación en cliente (absorbe jitter)
const SV_HEARTBEAT_MS  = 4000;
const SV_STALE_MS      = 9000; // sin heartbeat => compañero desconectado
const SV_COUNTDOWN_MS  = 3500;
const SV_LOGIC_TICK_MS = 100;  // "reloj de mapa": 10 ticks lógicos/seg, compartidos
const SV_TEAM_LIVES    = 5;    // vidas COMPARTIDAS del equipo (objetivo: sobrevivir juntos)

const svModal = () => roomModalBody; // reutiliza tu modal de salas existente

// ---------------------------------------------------------------------
// 3) ESTADO
// ---------------------------------------------------------------------
let svFlow = null;          // { matchId, uid, unsub, countdownTimer } — mientras se forma la sala
let survival = null;        // partida activa: ver svBeginRound()
let svSearchCancelled = false;

function svNewPlayerState() {
  return {
    name: (currentUser && currentUser.name) || 'Jugador',
    flag: (currentUser && currentUser.flag) || '🏳️',
    x: 0, y: 0, facing: 1, grounded: true, action: 'idle',
    lastSeen: Date.now()
  };
}

// ---------------------------------------------------------------------
// 4) MATCHMAKING (botón "🛡️ Modo Supervivencia (2 Jugadores)")
// ---------------------------------------------------------------------
// Añade este botón dentro de renderRoomMenu(), junto a los que ya tienes:
//   <button id="qm-pick-survival2p" class="room-btn">🛡️ Supervivencia (2 Jugadores)</button>
// y su listener:
//   document.getElementById('qm-pick-survival2p').addEventListener('click', startSurvivalSearch);

async function startSurvivalSearch() {
  svSearchCancelled = false;
  svModal().innerHTML = `
    <p class="room-status-line">Buscando compañero para Supervivencia…</p>
    <div class="room-spinner"></div>
    <button id="sv-cancel-search" class="room-btn secondary">Cancelar</button>
  `;
  document.getElementById('sv-cancel-search').addEventListener('click', () => {
    svSearchCancelled = true;
    teardownSurvivalFlow();
    renderRoomMenu();
  });

  try {
    const fb = await window.firebaseReady;
    const uid = fb.auth.currentUser && fb.auth.currentUser.uid;
    if (!uid) {
      svModal().innerHTML = `<p class="room-error">Debes iniciar sesión para jugar en línea.</p><button id="room-back-btn" class="room-btn secondary">Volver</button>`;
      document.getElementById('room-back-btn').addEventListener('click', renderRoomMenu);
      return;
    }
    const matchId = await svFindOrCreateMatch(fb, uid);
    if (svSearchCancelled) { svLeaveDoc(fb, matchId, uid); return; }

    svFlow = { matchId, uid, unsub: null, countdownTimer: null };
    listenSurvivalMatch(fb, matchId, uid);
  } catch (e) {
    console.error('Error en matchmaking de Supervivencia:', e);
    svModal().innerHTML = `<p class="room-error">${escapeHtml(roomErrorMessage(e))}</p><button id="room-back-btn" class="room-btn secondary">Volver</button>`;
    document.getElementById('room-back-btn').addEventListener('click', renderRoomMenu);
  }
}

// Busca una sala "esperando" con cupo (máx 2) y se une de forma ATÓMICA
// (transacción de Firestore evita que dos jugadores tomen el mismo cupo
// a la vez). Si no encuentra ninguna, crea una nueva con la semilla del mapa.
async function svFindOrCreateMatch(fb, uid) {
  const col = fb.collection(fb.db, 'survivalMatches');
  const q = fb.query(col, fb.where('status', '==', 'esperando'), fb.where('hostDevice', '==', DEVICE_TYPE), fb.limit(10));
  const snap = await fb.getDocs(q);
  for (const docSnap of snap.docs) {
    if (await svTryJoin(fb, docSnap.ref, uid)) return docSnap.id;
  }
  return await svCreateMatch(fb, uid);
}

async function svTryJoin(fb, ref, uid) {
  try {
    return await fb.runTransaction(fb.db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return false;
      const data = snap.data();
      if (data.status !== 'esperando') return false;
      if (data.players && data.players[uid]) return true; // reconexión
      const count = data.playerCount || 0;
      if (count >= 2) return false;

      const newCount = count + 1;
      const update = {
        playerCount: newCount,
        [`players.${uid}`]: svNewPlayerState(),
        playerOrder: [...(data.playerOrder || []), uid]
      };
      if (newCount >= 2) {
        update.status = 'jugando';
        // startAt: instante ACORDADO por ambos (mismo epoch ms para los dos
        // clientes) — es el "cero" del reloj de mapa compartido.
        update.startAt = Date.now() + SV_COUNTDOWN_MS;
      }
      tx.update(ref, update);
      return true;
    });
  } catch (e) {
    console.error('No se pudo unir a la sala de Supervivencia:', e);
    return false;
  }
}

async function svCreateMatch(fb, uid) {
  const ref = fb.doc(fb.collection(fb.db, 'survivalMatches')); // id único autogenerado
  // ★ SEMILLA COMPARTIDA: el host la genera UNA sola vez. Todo el mapa
  // (obstáculos, su x, su velocidad de caída, su fase de movimiento) se
  // deriva matemáticamente de este número + del "reloj de mapa" (ver
  // sección 6), así que NUNCA se transmite cada obstáculo por la red:
  // ambos clientes lo calculan de forma idéntica y local.
  const seed = (Math.random() * 2 ** 31) | 0;
  await fb.setDoc(ref, {
    status: 'esperando',
    seed,
    hostDevice: DEVICE_TYPE,
    createdAt: fb.serverTimestamp(),
    startAt: null,
    playerCount: 1,
    playerOrder: [uid],
    players: { [uid]: svNewPlayerState() },
    teamLives: SV_TEAM_LIVES,
    teamScore: 0,
    gameOver: false
  });
  return ref.id;
}

function svLeaveDoc(fb, matchId, uid) {
  if (!matchId || !uid) return;
  fb.runTransaction(fb.db, async (tx) => {
    const ref = fb.doc(fb.db, 'survivalMatches', matchId);
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const data = snap.data();
    const players = { ...(data.players || {}) };
    delete players[uid];
    const remaining = Object.keys(players);
    if (remaining.length === 0) { tx.delete(ref); return; }
    tx.update(ref, {
      players,
      playerCount: remaining.length,
      playerOrder: (data.playerOrder || []).filter(id => id !== uid)
    });
  }).catch(() => {});
}

function teardownSurvivalFlow() {
  if (!svFlow) return;
  if (svFlow.unsub) svFlow.unsub();
  if (svFlow.countdownTimer) clearTimeout(svFlow.countdownTimer);
  const { matchId, uid } = svFlow;
  if (matchId) window.firebaseReady.then(fb => svLeaveDoc(fb, matchId, uid));
  svFlow = null;
}

function listenSurvivalMatch(fb, matchId, uid) {
  const ref = fb.doc(fb.db, 'survivalMatches', matchId);
  const unsub = fb.onSnapshot(ref, (snap) => {
    if (!snap.exists()) {
      if (svFlow && svFlow.matchId === matchId) {
        svFlow = null;
        if (!roomModal.classList.contains('hidden')) renderRoomMenu();
      }
      return;
    }
    handleSurvivalSnapshot(matchId, uid, snap.data());
  }, (err) => console.error('Error escuchando Supervivencia:', err));
  if (svFlow && svFlow.matchId === matchId) svFlow.unsub = unsub;
  else if (survival && survival.matchId === matchId) survival.unsub = unsub;
}

function handleSurvivalSnapshot(matchId, uid, data) {
  if (data.status === 'esperando') {
    if (svFlow && svFlow.matchId === matchId) {
      svModal().innerHTML = `
        <p class="room-status-line">Esperando compañero… (${data.playerCount || 1}/2)</p>
        <div class="room-spinner"></div>
        <button id="sv-cancel-wait" class="room-btn secondary">Cancelar</button>
      `;
      document.getElementById('sv-cancel-wait').addEventListener('click', () => {
        teardownSurvivalFlow(); renderRoomMenu();
      });
    }
    return;
  }

  if (data.status === 'jugando' && !survival) {
    if (svFlow && svFlow.matchId === matchId && !svFlow.countdownTimer && data.startAt) {
      svModal().innerHTML = `<p class="room-status-line">¡Compañero encontrado! Preparando mapa compartido…</p><p class="room-status-line" id="sv-countdown-val">…</p>`;
      const tick = () => {
        if (!svFlow) return;
        const remaining = data.startAt - Date.now();
        const el = document.getElementById('sv-countdown-val');
        if (remaining <= 0) {
          if (el) el.textContent = '¡YA!';
          svBeginRound(matchId, uid, data);
          return;
        }
        if (el) el.textContent = Math.ceil(remaining / 1000) + '…';
        svFlow.countdownTimer = setTimeout(tick, 120);
      };
      tick();
    }
    return;
  }

  if (survival && survival.matchId === matchId) svApplyUpdate(data);
}

// ---------------------------------------------------------------------
// 5) INICIO DE LA PARTIDA
// ---------------------------------------------------------------------
function svBeginRound(matchId, uid, data) {
  if (svFlow && svFlow.countdownTimer) clearTimeout(svFlow.countdownTimer);
  const partnerId = (data.playerOrder || []).find(id => id !== uid) || null;
  const partner = partnerId ? data.players[partnerId] : null;

  survival = {
    matchId, uid, partnerId,
    unsub: svFlow ? svFlow.unsub : null,
    startAt: data.startAt,           // "cero" del reloj de mapa, común a ambos
    rng: mulberry32(data.seed),      // generador local, mismo seed que el rival
    nextLogicTick: 0,                // próximo tick lógico de mapa a procesar
    lastBroadcast: 0,
    heartbeatTimer: null, staleCheckTimer: null,
    teamLives: data.teamLives ?? SV_TEAM_LIVES,
    teamScore: data.teamScore || 0,
    gameOver: !!data.gameOver,
    resultShown: false,
    companion: {
      name: partner ? partner.name : 'Compañero',
      prevX: 0, prevY: 0, nextX: 0, nextY: 0, curX: 0, curY: 0,
      facing: 1, action: 'idle', since: performance.now(),
      lastSeen: Date.now(), disconnected: false
    }
  };
  svFlow = null;
  roomModal.classList.add('hidden');
  updateControlsHint();

  mpHud.classList.remove('show'); qmHud.classList.remove('show'); // ocultamos HUDs de otros modos
  document.getElementById('sv-hud')?.classList.add('show');       // ver nota de HUD abajo

  svObstacles.length = 0;
  svStartHeartbeat();
  resetGame();
  lives = survival.teamLives; // el HUD de vidas muestra las vidas del EQUIPO, no las individuales
  renderLives();
}

function svApplyUpdate(data) {
  const partner = survival.partnerId ? data.players[survival.partnerId] : null;
  const c = survival.companion;
  if (!partner) {
    c.disconnected = true; c.action = 'idle';
  } else {
    if (partner.x !== c.nextX || partner.y !== c.nextY) {
      c.prevX = c.curX; c.prevY = c.curY;
      c.nextX = partner.x; c.nextY = partner.y;
      c.since = performance.now();
    }
    c.facing = partner.facing || 1;
    c.action = partner.action || 'idle';
    if (partner.lastSeen) c.lastSeen = partner.lastSeen;
  }

  survival.teamLives = Math.max(0, data.teamLives ?? survival.teamLives);
  survival.teamScore = data.teamScore || survival.teamScore;
  lives = survival.teamLives;
  const livesEl = document.getElementById('sv-team-lives');
  if (livesEl) livesEl.textContent = survival.teamLives;

  if (data.gameOver && !survival.resultShown) {
    survival.resultShown = true;
    svShowResult(data);
  }
}

// ---------------------------------------------------------------------
// 6) MAPA COMPARTIDO — obstáculos deterministas por semilla
// ---------------------------------------------------------------------
// Clave para que "las mismas coordenadas al mismo segundo" sea real: la
// posición de cada obstáculo NO se integra frame a frame con dt local
// (eso divergiría entre un móvil a 60fps y otro a 45fps). En vez de eso,
// cada obstáculo guarda el instante lógico en que nació y su velocidad;
// su posición en cualquier momento se CALCULA como función del reloj de
// mapa compartido (elapsed), así que a un mismo "elapsed" ambos clientes
// obtienen exactamente el mismo x,y sin importar su framerate local.
let svObstacles = [];

function svElapsed() {
  // Reloj de mapa compartido: mismo origen (survival.startAt) en ambos
  // dispositivos. Usa Date.now() (no performance.now()) porque startAt
  // viene como epoch ms de Firestore.
  return Math.max(0, Date.now() - survival.startAt);
}

function svSpawnChance(elapsedSec) {
  // Dificultad progresiva, igual de espíritu que spawnChanceForLevel().
  return Math.min(0.10 + elapsedSec * 0.002, 0.42);
}
function svFallSpeed(rng, elapsedSec) {
  return 1.3 + rng() * 0.7 + Math.min(elapsedSec * 0.02, 3.2);
}

function svUpdateObstacles(time) {
  if (!survival || gameState !== 'PLAYING') return;
  const elapsed = svElapsed();
  const currentTick = Math.floor(elapsed / SV_LOGIC_TICK_MS);

  // Procesa cada tick lógico transcurrido, EN ORDEN, consumiendo el rng
  // el mismo número de veces que el otro cliente para el mismo tick.
  while (survival.nextLogicTick <= currentTick) {
    const tick = survival.nextLogicTick;
    const tickElapsedMs = tick * SV_LOGIC_TICK_MS;
    const elapsedSec = tickElapsedMs / 1000;
    const roll = survival.rng();
    if (roll < svSpawnChance(elapsedSec)) {
      svObstacles.push({
        id: tick,                              // determinista: útil para depurar
        nx: survival.rng(),                    // x NORMALIZADO (0..1): así funciona
                                                // igual aunque las pantallas tengan
                                                // tamaños distintos (móvil vs escritorio)
        radius: 9 + survival.rng() * 3,
        spawnElapsed: tickElapsedMs,
        fallSpeedPxS: svFallSpeed(survival.rng, elapsedSec) * 60, // px/seg (referencia 60fps)
        driftAmp: (survival.rng() - 0.5) * 0.05,  // deriva horizontal, fracción del ancho
        driftFreq: 0.0012 + survival.rng() * 0.001,
        phase: survival.rng() * Math.PI * 2
      });
    }
    survival.nextLogicTick++;
  }

  // Posición actual de cada obstáculo = función pura del tiempo transcurrido
  // desde que nació (no de un dt acumulado) → idéntica en ambos clientes.
  for (let i = svObstacles.length - 1; i >= 0; i--) {
    const o = svObstacles[i];
    const age = elapsed - o.spawnElapsed;
    const y = -20 + o.fallSpeedPxS * (age / 1000);
    if (y > cssH + 30) { svObstacles.splice(i, 1); continue; }
    o.x = o.nx * cssW + Math.sin(o.phase + elapsed * o.driftFreq) * o.driftAmp * cssW;
    o.y = y;
  }

  svCheckLocalCollisions();
}

function svDrawObstacles() {
  ctx.save();
  for (const o of svObstacles) {
    const grad = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, o.radius * 2.2);
    grad.addColorStop(0, 'rgba(96,165,250,0.95)');
    grad.addColorStop(1, 'rgba(96,165,250,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(o.x, o.y, o.radius * 2.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#dbeafe';
    ctx.beginPath(); ctx.arc(o.x, o.y, o.radius, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// Cada cliente detecta SUS PROPIOS golpes contra el mapa compartido (igual
// que hoy detecta sus propios golpes en modo un jugador) y le resta una
// vida al POZO COMÚN del equipo mediante una transacción atómica —evita
// que, si ambos chocan casi al mismo tiempo, se pierda un descuento por
// condición de carrera.
function svCheckLocalCollisions() {
  for (let i = svObstacles.length - 1; i >= 0; i--) {
    const o = svObstacles[i];
    if (player.invincible) continue;
    const dx = player.x - o.x, dy = (player.y - player.height / 2) - o.y;
    const hitDist = o.radius + player.width / 2.2;
    if (dx * dx + dy * dy < hitDist * hitDist) {
      svObstacles.splice(i, 1);
      svReportHit();
    }
  }
}

function svReportHit() {
  if (!survival) return;
  player.invincible = true;
  player.invincibleUntil = clock + 1200;
  window.firebaseReady.then(fb => {
    if (!survival) return;
    const ref = fb.doc(fb.db, 'survivalMatches', survival.matchId);
    fb.runTransaction(fb.db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      const data = snap.data();
      const newLives = Math.max(0, (data.teamLives ?? SV_TEAM_LIVES) - 1);
      const update = { teamLives: newLives };
      if (newLives <= 0) update.gameOver = true; // ★★ objetivo cumplido/fallado: se acabaron las vidas DEL EQUIPO
      tx.update(ref, update);
    }).catch(() => {});
  });
}

// Suma puntos al marcador COMPARTIDO (llámalo, por ejemplo, cada segundo
// sobrevivido, igual que ya acumulas `score` en modo un jugador).
function svAddTeamScore(points) {
  if (!survival) return;
  window.firebaseReady.then(fb => {
    fb.updateDoc(fb.doc(fb.db, 'survivalMatches', survival.matchId), {
      teamScore: fb.increment(points)
    }).catch(() => {});
  });
}

// ---------------------------------------------------------------------
// 7) SINCRONIZACIÓN DE POSICIÓN (anti-lag) — tick 10-15/s + interpolación
// ---------------------------------------------------------------------
function svBroadcastFrame(time) {
  if (!survival || gameState !== 'PLAYING') return;
  if (time - survival.lastBroadcast < SV_TICK_MS) return;
  survival.lastBroadcast = time;

  const action = (clock - lastShotAt) < SHOT_POSE_DURATION ? 'shoot'
    : (!player.grounded ? 'jump' : ((keys.left || keys.right) ? 'run' : 'idle'));

  window.firebaseReady.then(fb => {
    if (!survival) return;
    fb.updateDoc(fb.doc(fb.db, 'survivalMatches', survival.matchId), {
      [`players.${survival.uid}.x`]: Math.round(player.x),
      [`players.${survival.uid}.y`]: Math.round(player.y),
      [`players.${survival.uid}.facing`]: player.facing,
      [`players.${survival.uid}.action`]: action,
      [`players.${survival.uid}.lastSeen`]: Date.now()
    }).catch(() => {});
  });
}

// Interpolación lineal: se llama cada frame (rAF), independientemente de
// cuándo llegó el último paquete de red, para que el compañero se vea
// fluido en el canvas aunque los datos lleguen solo ~13 veces/segundo.
function svUpdateInterpolation(nowMs) {
  if (!survival) return;
  const c = survival.companion;
  if (c.disconnected) return;
  const t = Math.min(1, (nowMs - c.since) / SV_INTERP_MS);
  c.curX = c.prevX + (c.nextX - c.prevX) * t;
  c.curY = c.prevY + (c.nextY - c.prevY) * t;
}

function svStartHeartbeat() {
  svSendHeartbeat();
  survival.heartbeatTimer = setInterval(svSendHeartbeat, SV_HEARTBEAT_MS);
  survival.staleCheckTimer = setInterval(svCheckStalePartner, SV_HEARTBEAT_MS);
}
function svSendHeartbeat() {
  if (!survival) return;
  window.firebaseReady.then(fb => {
    if (!survival) return;
    fb.updateDoc(fb.doc(fb.db, 'survivalMatches', survival.matchId), {
      [`players.${survival.uid}.lastSeen`]: Date.now()
    }).catch(() => {});
  });
}
function svCheckStalePartner() {
  if (!survival) return;
  const c = survival.companion;
  if (c.disconnected) return;
  if (Date.now() - c.lastSeen > SV_STALE_MS) {
    c.disconnected = true;
    const statusEl = document.getElementById('sv-companion-status');
    if (statusEl) statusEl.textContent = '🔌 Desconectado — sigues jugando solo';
  }
}

// ---------------------------------------------------------------------
// 8) RENDERIZADO EN CANVAS — ambos personajes en el mismo escenario
// ---------------------------------------------------------------------
// Dibuja al compañero con el mismo sprite que tu drawPlayer(time), pero
// en la posición interpolada. Si tu drawPlayer(time) dibuja siempre sobre
// la variable global `player`, la forma más simple y segura de reutilizar
// exactamente el mismo arte es: guardar player, sustituirlo temporalmente
// por un "player fantasma" en la posición del compañero, dibujar, y
// restaurar. Así no duplicas la lógica visual de tu personaje.
function svDrawCompanion(time) {
  if (!survival || survival.companion.disconnected) return;
  const c = survival.companion;
  const backup = player;
  player = {
    ...backup,
    x: c.curX, y: c.curY, facing: c.facing,
    vx: c.action === 'run' ? backup.speed * c.facing : 0,
    vy: c.action === 'jump' ? backup.jumpForce : 0,
    grounded: c.action !== 'jump',
    invincible: false, shieldActive: false,
    walkPhase: (time / 90) % (Math.PI * 2),
    trail: []
  };
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.filter = 'hue-rotate(130deg)'; // tinte distinto para diferenciar al compañero
  drawPlayer(time);
  ctx.filter = 'none';
  ctx.restore();
  player = backup;
}

// Punto de entrada de dibujo de la escena de Supervivencia. Sustituye, SOLO
// mientras `survival` esté activo, a tu secuencia normal de
// drawObstacles()+drawPlayer() dentro de loop().
function svDrawScene(time) {
  svDrawObstacles();
  svDrawCompanion(time);
  drawPlayer(time); // tu propio personaje, con tu arte normal sin tinte
}

function svShowResult(data) {
  const survived = (data.teamLives ?? 0) > 0 ? false : true; // gameOver=true implica vidas en 0
  finalScoreWrap.style.display = 'none';
  mpResultEl.style.display = 'block';
  mpResultEl.innerHTML = `
    <span class="final-score-label" style="color:${survived ? '#f87171' : '#34d399'};">
      ${survived ? '💀 EL EQUIPO CAYÓ' : '🏆 ¡SOBREVIVIERON!'}
    </span>
    <div class="vs-row" style="margin-top:6px;">
      <span class="vs-name">Puntaje del equipo: <b>${data.teamScore || 0}</b></span>
    </div>
  `;
  statusMsg.textContent = 'GAME OVER';
}

function leaveSurvival() {
  if (survival) {
    if (survival.unsub) survival.unsub();
    if (survival.heartbeatTimer) clearInterval(survival.heartbeatTimer);
    if (survival.staleCheckTimer) clearInterval(survival.staleCheckTimer);
    window.firebaseReady.then(fb => svLeaveDoc(fb, survival.matchId, survival.uid));
    survival = null;
  }
  document.getElementById('sv-hud')?.classList.remove('show');
}

// =====================================================================
// INTEGRACIÓN — 4 puntos exactos a tocar en tu archivo
// =====================================================================
//
// A) En renderRoomMenu(), agrega el botón y su listener junto a los que
//    ya tienes (qm-pick-survival, qm-pick-2vs2):
//
//      <button id="qm-pick-survival2p" class="room-btn">🛡️ Supervivencia (2 Jugadores)</button>
//      ...
//      document.getElementById('qm-pick-survival2p').addEventListener('click', startSurvivalSearch);
//
// B) En tu función loop(time), añade (junto a mpThrottledSync/mpBroadcastFrame/qmUpdateInterpolation):
//
//      svBroadcastFrame(time);        // ★ transmite mi posición 10-15 veces/seg
//      svUpdateInterpolation(time);   // ★ interpola al compañero cada frame
//      if (survival) svUpdateObstacles(time); // ★ avanza el mapa compartido y detecta mis choques
//
//    Y en el bloque de dibujo, cuando `survival` esté activo, dibuja la
//    escena coop EN VEZ DE tu drawObstacles()+drawPlayer() normales:
//
//      if (survival) {
//        svDrawScene(time);
//      } else {
//        drawObstacles(time);
//        ...
//        if (player.grounded !== undefined) drawPlayer(time);
//      }
//
// C) Añade un pequeño HUD para el modo (similar a tu #mp-hud / #qm-hud),
//    con id="sv-hud", que muestre nombre del compañero, ❤️ vidas del
//    equipo (id="sv-team-lives") y estado de conexión (id="sv-companion-status").
//
// D) Cuando el jugador sale/cierra partida (tu botón de "salir" o el cierre
//    de pestaña), llama a leaveSurvival() igual que ya haces con
//    leaveMultiplayer()/leaveQuickMatch().
// =====================================================================