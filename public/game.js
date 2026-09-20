(() => {
  "use strict";

  const W = 720, H = 720;
  const MIN = 62, MAX = 658;
  const BASELINE_Y = 600;
  const STRIKER_R = 17, COIN_R = 13, POCKET_R = 29;
  const FRICTION = 0.986;
  const STOP_SPEED = 0.045;
  const TURN_TIME = 30;

  const canvas = document.getElementById("gameCanvas");
  const ctx = canvas.getContext("2d");
  const socket = io();

  const $ = id => document.getElementById(id);

  let mode = "single";
  let difficulty = "medium";
  let myPlayer = 1;
  let roomId = null;
  let currentTurn = 1;
  let gameOver = false;
  let paused = false;
  let waiting = false;

  let turnStartedAt = Date.now();
  let scores = {1:0, 2:0};
  let names = {1:"Player 1", 2:"AI"};

  let coins = [];
  let striker = {x:360, y:BASELINE_Y, vx:0, vy:0, pocketed:false};
  let aimAngle = -Math.PI / 2;
  let power = .55;

  let draggingStriker = false;
  let draggingAim = false;
  let shotInProgress = false;
  let pocketedThisShot = 0;
  let queenPocketedThisShot = false;
  let strikerFoulThisShot = false;
  let shotWasLocal = false;
  let aiTimer = null;
  let lastTime = performance.now();
  let audioCtx = null;
  let masterGain = null;
  let musicGain = null;
  let soundEnabled = true;
  let musicEnabled = true;
  let musicTimer = null;
  let musicStep = 0;

  function initAudio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = audioCtx.createGain();
      musicGain = audioCtx.createGain();
      masterGain.gain.value = 0.72;
      musicGain.gain.value = 0.09;
      masterGain.connect(audioCtx.destination);
      musicGain.connect(masterGain);
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    if (!musicTimer) musicTimer = setInterval(musicBeat, 320);
  }

  function tone(freq, duration=.08, type="sine", volume=.12, destination=masterGain, detune=0) {
    if (!audioCtx || !destination) return;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.value = freq;
    o.detune.value = detune;
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(Math.max(.0001, volume), audioCtx.currentTime + .008);
    g.gain.exponentialRampToValueAtTime(.0001, audioCtx.currentTime + duration);
    o.connect(g).connect(destination);
    o.start();
    o.stop(audioCtx.currentTime + duration + .02);
  }

  function noise(duration=.08, volume=.12, filterFreq=1200) {
    if (!audioCtx || !masterGain || !soundEnabled) return;
    const buffer = audioCtx.createBuffer(1, audioCtx.sampleRate * duration, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i=0;i<data.length;i++) data[i] = (Math.random()*2-1) * (1-i/data.length);
    const src = audioCtx.createBufferSource();
    const filter = audioCtx.createBiquadFilter();
    const g = audioCtx.createGain();
    filter.type = "bandpass";
    filter.frequency.value = filterFreq;
    filter.Q.value = 1.4;
    g.gain.value = volume;
    src.buffer = buffer;
    src.connect(filter).connect(g).connect(masterGain);
    src.start();
  }

  function coinCollisionSound(strength=1) {
    if (!soundEnabled) return;
    const f = 300 + Math.min(800, strength * 110);
    tone(f, .045, "triangle", .055 * Math.min(2,strength));
    noise(.035, .035 * Math.min(2,strength), 1800);
  }

  function strikerHitSound(strength=1) {
    if (!soundEnabled) return;
    tone(150 + strength*100, .07, "triangle", .10);
    noise(.045, .05, 900);
  }

  function pocketSound() {
    if (!soundEnabled) return;
    tone(110, .12, "sine", .12);
    setTimeout(() => tone(70, .16, "sine", .08), 45);
  }

  function buttonSound() {
    if (!soundEnabled) return;
    tone(520, .045, "square", .045);
    tone(760, .06, "square", .035);
  }

  function musicBeat() {
    if (!audioCtx || !musicEnabled || paused || gameOver) return;
    const notes = [196, 246.94, 293.66, 329.63, 293.66, 246.94, 220, 293.66];
    tone(notes[musicStep++ % notes.length], .20, "triangle", .45, musicGain);
  }

  function toggleSound() {
    soundEnabled = !soundEnabled;
    $("soundBtn").textContent = soundEnabled ? "🔊" : "🔇";
    if (soundEnabled) {
      initAudio();
      buttonSound();
    }
  }

  function toggleMusic() {
    musicEnabled = !musicEnabled;
    $("musicBtn").textContent = musicEnabled ? "🎵" : "🎵̸";
    initAudio();
  }

  function show(screen) {
    $("homeScreen").classList.toggle("active", screen === "home");
    $("gameScreen").classList.toggle("active", screen === "game");
  }

  function message(t) { $("homeMessage").textContent = t || ""; }

  function resetBoard() {
    coins = [];
    const centerX = W/2, centerY = 350;
    const positions = [
      [0,0],
      [27,0],[-27,0],[0,27],[0,-27],
      [27,27],[-27,27],[27,-27],[-27,-27],
      [54,0],[-54,0],[0,54],[0,-54],
      [54,27],[-54,27],[54,-27],[-54,-27],
      [27,54],[-27,54]
    ];
    positions.forEach((p,i) => {
      coins.push({
        x:centerX+p[0], y:centerY+p[1],
        vx:0, vy:0,
        color:i===0 ? "queen" : (i%2 ? "white" : "black"),
        pocketed:false
      });
    });
    striker = {x:360,y:BASELINE_Y,vx:0,vy:0,pocketed:false};
    shotInProgress = false;
    pocketedThisShot = 0;
    queenPocketedThisShot = false;
    strikerFoulThisShot = false;
    aimAngle = -Math.PI/2;
    $("positionSlider").value = 360;
    updatePowerUI();
    updateAngleUI();
  }

  function startSingle() {
    initAudio();
    buttonSound();
    mode = "single";
    myPlayer = 1;
    roomId = null;
    difficulty = $("difficultySelect").value;
    names = {1: ($("nameInput").value.trim() || "Player 1").slice(0,18), 2:"AI"};
    scores = {1:0,2:0};
    currentTurn = 1;
    gameOver = false;
    paused = false;
    waiting = false;
    resetBoard();
    setGameUI();
    show("game");
  }

  function createRoom() {
    initAudio();
    buttonSound();
    const name = $("nameInput").value.trim() || "Player 1";
    socket.emit("createRoom", {name});
  }

  function joinRoom() {
    initAudio();
    buttonSound();
    const id = $("roomInput").value.trim().toUpperCase();
    if (id.length !== 4) return message("Enter a 4-character room code.");
    const name = $("nameInput").value.trim() || "Player 2";
    socket.emit("joinRoom", {roomId:id, name});
  }

  function startOnline(player, id) {
    mode = "online";
    myPlayer = player;
    roomId = id;
    gameOver = false;
    paused = false;
    waiting = player === 1;
    resetBoard();
    setGameUI();
    show("game");
    $("roomLabel").textContent = `Room ${roomId}`;
    $("roomCodeDisplay").textContent = roomId;
    $("waitingOverlay").classList.toggle("hidden", !waiting);
  }

  function setGameUI() {
    $("p1Name").textContent = names[1];
    $("p2Name").textContent = names[2];
    $("p1Score").textContent = scores[1];
    $("p2Score").textContent = scores[2];
    $("pauseBtn").disabled = mode === "online" && waiting;
  }

  function canShoot() {
    return !gameOver && !paused && !shotInProgress && !waiting && currentTurn === myPlayer;
  }

  function setStrikerX(x) {
    striker.x = Math.max(85, Math.min(635, x));
    $("positionSlider").value = striker.x;
  }

  function canvasPoint(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (e.clientX-r.left) * W/r.width,
      y: (e.clientY-r.top) * H/r.height
    };
  }

  function setAimFromPoint(p) {
    const dx = p.x - striker.x;
    const dy = p.y - striker.y;
    if (Math.hypot(dx,dy) < 10) return;
    aimAngle = Math.atan2(dy, dx);
    updateAngleUI();
  }

  function updateAngleUI() {
    let deg = Math.round(aimAngle * 180 / Math.PI);
    $("angleText").textContent = `${deg}°`;
  }

  function updatePowerUI() {
    $("powerText").textContent = `${Math.round(power*100)}%`;
  }

  function shoot(force=false) {
    if (!force && !canShoot()) return;
    if (force && (mode !== "single" || currentTurn !== 2 || gameOver || paused || shotInProgress)) return;

    initAudio();
    buttonSound();

    shotInProgress = true;
    pocketedThisShot = 0;
    queenPocketedThisShot = false;
    strikerFoulThisShot = false;
    shotWasLocal = true;

    const speed = 8 + power * 17;
    striker.vx = Math.cos(aimAngle) * speed;
    striker.vy = Math.sin(aimAngle) * speed;

    strikerHitSound(0.7 + power);

    if (mode === "online") {
      socket.emit("shot", {
        x:striker.x,
        angle:aimAngle,
        power,
        shotId:Date.now().toString()
      });
    }
  }

  function shootRemote(data) {
    if (gameOver) return;
    striker.x = data.x;
    striker.y = BASELINE_Y;
    striker.pocketed = false;
    striker.vx = Math.cos(data.angle) * (8 + data.power*17);
    striker.vy = Math.sin(data.angle) * (8 + data.power*17);
    aimAngle = data.angle;
    shotInProgress = true;
    shotWasLocal = false;
    pocketedThisShot = 0;
    queenPocketedThisShot = false;
    strikerFoulThisShot = false;
    strikerHitSound(.7 + data.power);
  }

  function finishShot() {
    if (!shotInProgress) return;

    coins.forEach(c => {
      c.vx = 0; c.vy = 0;
      if (c.pocketed) c.pocketed = true;
    });
    striker.vx = striker.vy = 0;

    let points = pocketedThisShot;
    if (queenPocketedThisShot) points += 3;
    if (strikerFoulThisShot) points = 0;

    if (strikerFoulThisShot) {
      scores[myPlayer] = Math.max(0, scores[myPlayer]-1);
    }
    scores[myPlayer] += points;

    updateScores();

    const local = shotWasLocal;
    shotInProgress = false;

    if (scores[myPlayer] >= 10) {
      gameOver = true;
      showResult(myPlayer, "score");
      if (mode === "online" && local) socket.emit("shotResult", {points, foul:strikerFoulThisShot});
      return;
    }

    if (mode === "online") {
      if (local) socket.emit("shotResult", {points, foul:strikerFoulThisShot});
      // Server changes the turn. Do not change it locally.
      return;
    }

    const keep = points > 0 && !strikerFoulThisShot;
    currentTurn = keep ? currentTurn : (currentTurn === 1 ? 2 : 1);
    turnStartedAt = Date.now();
    resetForNextTurn();

    if (currentTurn === 2) {
      clearTimeout(aiTimer);
      aiTimer = setTimeout(aiShoot, 650);
    }
  }

  function resetForNextTurn() {
    striker.pocketed = false;
    striker.x = 360;
    striker.y = BASELINE_Y;
    striker.vx = striker.vy = 0;
    $("positionSlider").value = 360;
    aimAngle = -Math.PI/2;
    updateAngleUI();
  }

  function aiShoot() {
    if (mode !== "single" || currentTurn !== 2 || gameOver || paused || shotInProgress) return;

    const available = coins.filter(c => !c.pocketed && c.color !== "queen");
    if (!available.length) {
      aimAngle = -Math.PI/2;
      power = .6;
      shoot(true);
      return;
    }

    const target = available.reduce((best,c) =>
      Math.hypot(c.x-striker.x,c.y-striker.y) < Math.hypot(best.x-striker.x,best.y-striker.y) ? c : best
    , available[0]);

    const pocket = [
      {x:MIN,y:MIN},{x:MAX,y:MIN},{x:MIN,y:MAX},{x:MAX,y:MAX}
    ].reduce((best,p) =>
      Math.hypot(p.x-target.x,p.y-target.y) < Math.hypot(best.x-target.x,best.y-target.y) ? p : best
    );

    const dx = target.x-pocket.x;
    const dy = target.y-pocket.y;
    const len = Math.hypot(dx,dy) || 1;
    const contactX = target.x + dx/len * (COIN_R*2);
    const contactY = target.y + dy/len * (COIN_R*2);

    aimAngle = Math.atan2(contactY-striker.y, contactX-striker.x);

    if (difficulty === "easy") aimAngle += (Math.random()-.5)*.38;
    if (difficulty === "medium") aimAngle += (Math.random()-.5)*.16;
    if (difficulty === "hard") aimAngle += (Math.random()-.5)*.06;

    power = Math.min(1, Math.max(.32,
      Math.hypot(target.x-striker.x,target.y-striker.y)/500 + .25
    ));

    shoot(true);
  }

  function updatePhysics(dt) {
    if (paused || gameOver) return;

    const objects = [striker, ...coins.filter(c => !c.pocketed)];
    let moving = false;

    for (const o of objects) {
      o.x += o.vx * dt * 60;
      o.y += o.vy * dt * 60;

      o.vx *= Math.pow(FRICTION, dt*60);
      o.vy *= Math.pow(FRICTION, dt*60);

      const r = o === striker ? STRIKER_R : COIN_R;

      if (o.x-r < MIN) { o.x=MIN+r; o.vx=Math.abs(o.vx)*.88; }
      if (o.x+r > MAX) { o.x=MAX-r; o.vx=-Math.abs(o.vx)*.88; }
      if (o.y-r < MIN) { o.y=MIN+r; o.vy=Math.abs(o.vy)*.88; }
      if (o.y+r > MAX) { o.y=MAX-r; o.vy=-Math.abs(o.vy)*.88; }

      if (Math.hypot(o.vx,o.vy) > STOP_SPEED) moving = true;
      else { o.vx=0; o.vy=0; }
    }

    checkPockets();
    collideStrikerCoins();
    collideCoins();

    if (shotInProgress && !moving && allStopped()) {
      finishShot();
    }
  }

  function allStopped() {
    if (Math.hypot(striker.vx,striker.vy) > STOP_SPEED) return false;
    return coins.every(c => c.pocketed || Math.hypot(c.vx,c.vy) <= STOP_SPEED);
  }

  function checkPockets() {
    const pockets = [
      {x:MIN,y:MIN},{x:MAX,y:MIN},{x:MIN,y:MAX},{x:MAX,y:MAX}
    ];

    for (const c of coins) {
      if (c.pocketed) continue;
      for (const p of pockets) {
        if (Math.hypot(c.x-p.x,c.y-p.y) < POCKET_R) {
          c.pocketed = true;
          c.vx = c.vy = 0;
          pocketedThisShot++;
          if (c.color === "queen") {
            queenPocketedThisShot = true;
            scores[myPlayer] += 0; // queen bonus is added at shot end
          }
          pocketSound();
          break;
        }
      }
    }

    if (!striker.pocketed) {
      for (const p of pockets) {
        if (Math.hypot(striker.x-p.x,striker.y-p.y) < POCKET_R) {
          striker.pocketed = true;
          striker.vx = striker.vy = 0;
          strikerFoulThisShot = true;
          pocketSound();
          break;
        }
      }
    }
  }

  function collideStrikerCoins() {
    if (striker.pocketed) return;

    for (const c of coins) {
      if (c.pocketed) continue;
      resolveCollision(striker,c,STRIKER_R+COIN_R,true);
    }
  }

  function collideCoins() {
    for (let i=0;i<coins.length;i++) {
      if (coins[i].pocketed) continue;
      for (let j=i+1;j<coins.length;j++) {
        if (coins[j].pocketed) continue;
        resolveCollision(coins[i],coins[j],COIN_R*2,false);
      }
    }
  }

  function resolveCollision(a,b,minDist,isStriker) {
    let dx=b.x-a.x, dy=b.y-a.y;
    let dist=Math.hypot(dx,dy);
    if (dist===0) { dx=.01; dy=0; dist=.01; }
    if (dist>=minDist) return;

    const nx=dx/dist, ny=dy/dist;
    const overlap=minDist-dist;
    a.x -= nx*overlap*.5;
    a.y -= ny*overlap*.5;
    b.x += nx*overlap*.5;
    b.y += ny*overlap*.5;

    const rvx=b.vx-a.vx, rvy=b.vy-a.vy;
    const vel=rvx*nx+rvy*ny;
    if (vel >= 0) return;

    const restitution=isStriker ? .88 : .92;
    const impulse=-(1+restitution)*vel/2;
    a.vx -= impulse*nx;
    a.vy -= impulse*ny;
    b.vx += impulse*nx;
    b.vy += impulse*ny;

    const strength=Math.min(2,Math.abs(vel));
    if (strength>.25) {
      if (isStriker) strikerHitSound(strength);
      else coinCollisionSound(strength);
    }
  }

  function drawBoard() {
    ctx.clearRect(0,0,W,H);

    const g=ctx.createLinearGradient(0,0,W,H);
    g.addColorStop(0,"#f1c77b");
    g.addColorStop(.5,"#d59a52");
    g.addColorStop(1,"#b97535");

    ctx.fillStyle="#6b3c1e";
    ctx.fillRect(0,0,W,H);
    ctx.fillStyle=g;
    ctx.fillRect(28,28,664,664);

    ctx.fillStyle="#f2c979";
    ctx.fillRect(MIN,MIN,MAX-MIN,MAX-MIN);

    // board grain
    ctx.globalAlpha=.08;
    for(let i=0;i<70;i++){
      ctx.strokeStyle=i%2?"#6e3f20":"#fff";
      ctx.beginPath();
      const y=MIN+Math.random()*(MAX-MIN);
      ctx.moveTo(MIN,y); ctx.lineTo(MAX,y+(Math.random()-.5)*4); ctx.stroke();
    }
    ctx.globalAlpha=1;

    // pockets
    const ps=[[MIN,MIN],[MAX,MIN],[MIN,MAX],[MAX,MAX]];
    for(const [x,y] of ps){
      ctx.beginPath(); ctx.arc(x,y,POCKET_R+5,0,Math.PI*2); ctx.fillStyle="#4b2816"; ctx.fill();
      ctx.beginPath(); ctx.arc(x,y,POCKET_R,0,Math.PI*2); ctx.fillStyle="#090909"; ctx.fill();
    }

    // center
    ctx.beginPath(); ctx.arc(W/2,350,68,0,Math.PI*2); ctx.strokeStyle="#7d4c29"; ctx.lineWidth=3; ctx.stroke();
    ctx.beginPath(); ctx.arc(W/2,350,10,0,Math.PI*2); ctx.fillStyle="#7d4c29"; ctx.fill();

    // baselines
    ctx.strokeStyle="#7d4c29"; ctx.lineWidth=4;
    ctx.beginPath(); ctx.moveTo(105,BASELINE_Y);ctx.lineTo(615,BASELINE_Y);ctx.stroke();
    ctx.beginPath(); ctx.moveTo(105,BASELINE_Y+36);ctx.lineTo(615,BASELINE_Y+36);ctx.stroke();

    // striker guide
    if (canShoot() && !draggingStriker) {
      ctx.globalAlpha=.55;
      ctx.strokeStyle="#ffffff";
      ctx.lineWidth=2;
      ctx.beginPath();ctx.moveTo(striker.x-18,BASELINE_Y);ctx.lineTo(striker.x+18,BASELINE_Y);ctx.stroke();
      ctx.globalAlpha=1;
    }

    // aim line
    if (canShoot()) {
      const len=120+power*220;
      ctx.save();
      ctx.setLineDash([8,8]);
      ctx.strokeStyle="rgba(255,255,255,.7)";
      ctx.lineWidth=2;
      ctx.beginPath();
      ctx.moveTo(striker.x,striker.y);
      ctx.lineTo(striker.x+Math.cos(aimAngle)*len,striker.y+Math.sin(aimAngle)*len);
      ctx.stroke();
      ctx.restore();
    }

    for(const c of coins) if(!c.pocketed) drawCoin(c);
    if(!striker.pocketed) drawStriker();

    // power indicator on board
    if(canShoot()){
      ctx.fillStyle="rgba(0,0,0,.35)";
      ctx.fillRect(90,635,540,12);
      ctx.fillStyle="#ffd166";
      ctx.fillRect(90,635,540*power,12);
    }
  }

  function drawCoin(c) {
    const grad=ctx.createRadialGradient(c.x-4,c.y-5,2,c.x,c.y,COIN_R);
    if(c.color==="queen"){
      grad.addColorStop(0,"#ff6666");grad.addColorStop(1,"#8f1111");
    } else if(c.color==="white"){
      grad.addColorStop(0,"#fff");grad.addColorStop(1,"#bfc4cc");
    } else {
      grad.addColorStop(0,"#666");grad.addColorStop(1,"#111");
    }
    ctx.beginPath();ctx.arc(c.x,c.y,COIN_R,0,Math.PI*2);ctx.fillStyle=grad;ctx.fill();
    ctx.strokeStyle="rgba(0,0,0,.45)";ctx.lineWidth=2;ctx.stroke();
    if(c.color==="queen"){
      ctx.beginPath();ctx.arc(c.x,c.y,5,0,Math.PI*2);ctx.fillStyle="#ffd166";ctx.fill();
    }
  }

  function drawStriker() {
    const grad=ctx.createRadialGradient(striker.x-5,striker.y-5,2,striker.x,striker.y,STRIKER_R);
    grad.addColorStop(0,"#ffffff");grad.addColorStop(1,"#b9c1cd");
    ctx.beginPath();ctx.arc(striker.x,striker.y,STRIKER_R,0,Math.PI*2);ctx.fillStyle=grad;ctx.fill();
    ctx.strokeStyle="#222";ctx.lineWidth=3;ctx.stroke();
    ctx.beginPath();ctx.arc(striker.x,striker.y,7,0,Math.PI*2);ctx.strokeStyle="#c18b2c";ctx.lineWidth=2;ctx.stroke();
  }

  function updateScores() {
    $("p1Score").textContent=scores[1];
    $("p2Score").textContent=scores[2];
    $("p1Card").classList.toggle("active-player",currentTurn===1 && !gameOver);
    $("p2Card").classList.toggle("active-player",currentTurn===2 && !gameOver);
  }

  function updateTimers() {
    let remaining = Math.max(0, TURN_TIME - Math.floor((Date.now()-turnStartedAt)/1000));
    $("p1Timer").textContent=currentTurn===1 ? remaining : "—";
    $("p2Timer").textContent=currentTurn===2 ? remaining : "—";
  }

  function showResult(winner, reason) {
    gameOver=true;
    const winnerName=names[winner] || `Player ${winner}`;
    $("resultIcon").textContent=winner===myPlayer ? "🏆" : "😔";
    $("resultTitle").textContent=winner===myPlayer ? "You Win!" : "Game Over";
    $("resultMessage").textContent =
      reason==="opponent-left" ? "Your opponent left the game." :
      reason==="timeout" ? "The turn timer expired." :
      `${winnerName} reached the winning score.`;
    $("resultScore").textContent=`${names[1]} ${scores[1]}  —  ${scores[2]} ${names[2]}`;
    $("resultOverlay").classList.remove("hidden");
  }

  function leaveGame() {
    buttonSound();
    if(mode==="online") socket.emit("leaveRoom");
    clearTimeout(aiTimer);
    gameOver=true;
    show("home");
    $("resultOverlay").classList.add("hidden");
    $("waitingOverlay").classList.add("hidden");
  }

  function resetAim() {
    aimAngle=-Math.PI/2;
    updateAngleUI();
    buttonSound();
  }

  // Canvas: striker horizontal drag + aim drag.
  canvas.addEventListener("pointerdown", e => {
    if (!canShoot()) return;
    initAudio();
    const p=canvasPoint(e);
    const d=Math.hypot(p.x-striker.x,p.y-striker.y);

    if (d <= 38 && Math.abs(p.y-BASELINE_Y) < 45) {
      draggingStriker=true;
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    draggingAim=true;
    canvas.setPointerCapture(e.pointerId);
    setAimFromPoint(p);
  });

  canvas.addEventListener("pointermove", e => {
    if (!draggingStriker && !draggingAim) return;
    const p=canvasPoint(e);

    if (draggingStriker) {
      setStrikerX(p.x);
    } else {
      setAimFromPoint(p);
    }
  });

  function endPointer() {
    draggingStriker=false;
    draggingAim=false;
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", () => {});

  $("positionSlider").addEventListener("input", e => {
    if (!canShoot()) return;
    setStrikerX(Number(e.target.value));
  });

  $("powerSlider").addEventListener("input", e => {
    power=Number(e.target.value)/100;
    updatePowerUI();
  });

  $("shootBtn").addEventListener("click", () => shoot(false));
  $("resetAimBtn").addEventListener("click", resetAim);
  $("soundBtn").addEventListener("click", toggleSound);
  $("musicBtn").addEventListener("click", toggleMusic);

  $("pauseBtn").addEventListener("click", () => {
    if(mode==="online"){
      socket.emit("pauseGame");
    } else {
      paused=!paused;
      $("pauseOverlay").classList.toggle("hidden",!paused);
      if(!paused) turnStartedAt=Date.now();
      buttonSound();
    }
  });

  $("resumeBtn").addEventListener("click", () => {
    if(mode==="online") socket.emit("resumeGame");
    else {
      paused=false;
      $("pauseOverlay").classList.add("hidden");
      turnStartedAt=Date.now();
      buttonSound();
    }
  });

  $("leaveBtn").addEventListener("click", leaveGame);
  $("homeBtn").addEventListener("click", leaveGame);

  $("rematchBtn").addEventListener("click", () => {
    buttonSound();
    if(mode==="online") {
      socket.emit("requestRematch");
      $("rematchBtn").textContent="Waiting...";
      $("rematchBtn").disabled=true;
    } else {
      startSingle();
      $("resultOverlay").classList.add("hidden");
    }
  });

  $("singleBtn").addEventListener("click", startSingle);
  $("createBtn").addEventListener("click", createRoom);
  $("joinBtn").addEventListener("click", joinRoom);
  $("homeThemeBtn").addEventListener("click", () => {
    document.body.classList.toggle("light");
  });

  $("copyRoomBtn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(roomId || "");
      $("copyRoomBtn").textContent="Copied!";
      setTimeout(()=>$("copyRoomBtn").textContent="Copy code",1000);
    } catch {}
  });

  socket.on("roomCreated", ({roomId:id, player}) => {
    startOnline(player,id);
  });

  socket.on("joinedRoom", ({roomId:id, player}) => {
    startOnline(player,id);
    waiting=false;
    $("waitingOverlay").classList.add("hidden");
  });

  socket.on("gameReady", state => {
    applyServerState(state);
    waiting=false;
    $("waitingOverlay").classList.add("hidden");
  });

  socket.on("state", applyServerState);

  function applyServerState(state) {
    if (!state) return;
    roomId=state.roomId || roomId;
    currentTurn=state.turn;
    paused=state.paused;
    gameOver=state.gameOver;
    scores={...state.scores};
    names={...state.names};
    turnStartedAt=state.turnStartedAt || Date.now();

    if (state.players && state.players.length>=2) {
      waiting=false;
      $("waitingOverlay").classList.add("hidden");
    }

    setGameUI();
    updateScores();

    if (paused) $("pauseOverlay").classList.remove("hidden");
    else $("pauseOverlay").classList.add("hidden");

    if (currentTurn===myPlayer && !shotInProgress) resetForNextTurn();
  }

  socket.on("remoteShot", data => {
    if (mode!=="online") return;
    if (data.shooter===myPlayer) return;
    shootRemote(data);
  });

  socket.on("paused", () => {
    paused=true;
    $("pauseOverlay").classList.remove("hidden");
  });

  socket.on("resumed", data => {
    paused=false;
    turnStartedAt=data.turnStartedAt || Date.now();
    $("pauseOverlay").classList.add("hidden");
  });

  socket.on("gameOver", data => {
    scores={...data.scores};
    names={...data.names};
    updateScores();
    showResult(data.winner,data.reason);
  });

  socket.on("opponentLeft", () => {
    if (gameOver) return;
    showResult(myPlayer,"opponent-left");
  });

  socket.on("rematchStart", state => {
    $("resultOverlay").classList.add("hidden");
    $("rematchBtn").textContent="🔄 Rematch";
    $("rematchBtn").disabled=false;
    resetBoard();
    applyServerState(state);
    gameOver=false;
  });

  socket.on("errorMessage", text => {
    message(text);
    alert(text);
  });

  function loop(now) {
    const dt=Math.min(.033,(now-lastTime)/1000);
    lastTime=now;
    updatePhysics(dt);
    drawBoard();
    updateTimers();
    requestAnimationFrame(loop);
  }

  // Make audio respond to the first user gesture.
  ["pointerdown","touchstart","keydown"].forEach(evt => {
    window.addEventListener(evt, () => { if(audioCtx && audioCtx.state==="suspended") audioCtx.resume(); }, {once:false});
  });

  resetBoard();
  updatePowerUI();
  updateAngleUI();
  requestAnimationFrame(loop);
})();
