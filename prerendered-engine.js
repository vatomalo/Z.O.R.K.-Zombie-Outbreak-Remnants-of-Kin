const ROOM_MANIFEST = {
  apt_708_entry: 'rooms/apt_708_entry/room.json',
  hallway_7f: 'rooms/hallway_7f/room.json',
};

const FACING_ANGLES = {
  up: Math.PI,
  down: 0,
  left: Math.PI / 2,
  right: -Math.PI / 2,
};

class RoomData {
  constructor(data) {
    Object.assign(this, data);
    this.actors = data.actors || [];
    this.hotspots = data.hotspots || [];
    this.exits = data.exits || [];
    this.walkArea = data.walkArea || [];
    this.spawns = data.spawns || {};
  }
}

class LayeredRoomRenderer {
  constructor(canvas, ui) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ui = ui;
    this.room = null;
    this.images = {};
    this.actors = [];
    this.player = null;
    this.width = 1920;
    this.height = 1080;
    this.fade = 0;
    this.fadeDirection = 0;
    this.lastTime = 0;
    this.pointer = { x: 0, y: 0 };
    this.message = 'Walking through frozen memories.';
    this.noiseTime = 0;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.voiceExtensions = ['mp3', 'wav', 'ogg'];
    this.resize();
    window.addEventListener('resize', () => this.resize());
    canvas.addEventListener('click', (event) => this.handleClick(event));
    canvas.addEventListener('mousemove', (event) => {
      this.pointer = this.toRoomPoint(event);
    });
  }

  async start(roomId = 'apt_708_entry') {
    await this.loadRoom(roomId);
    this.lastTime = performance.now();
    requestAnimationFrame((time) => this.frame(time));
  }

  async loadRoom(roomId, spawnId = null) {
    const response = await fetch(ROOM_MANIFEST[roomId]);
    const data = await response.json();
    this.room = new RoomData(data);
    this.width = this.room.camera.width;
    this.height = this.room.camera.height;
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.images = await this.loadLayers(this.room.layers);
    const spawn = spawnId && this.room.spawns[spawnId] ? this.room.spawns[spawnId] : this.room.playerStart;
    this.player = new ScreenActor({
      id: 'romeo',
      label: 'Romeo',
      type: 'player',
      x: spawn.x,
      y: spawn.y,
      facing: spawn.facing || 'down',
      color: '#242a30',
      coat: '#151617',
      speed: 150,
      scaleMin: 0.62,
      scaleMax: 1.18,
    });
    this.actors = this.room.actors.map((actor) => new ScreenActor(actor));
    this.updateUI();
  }

  async loadLayers(layers) {
    const entries = await Promise.all(Object.entries(layers).map(async ([key, src]) => [key, await loadImage(src)]));
    return Object.fromEntries(entries);
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const scale = Math.min(rect.width / this.width, rect.height / this.height);
    this.canvas.style.width = `${this.width * scale}px`;
    this.canvas.style.height = `${this.height * scale}px`;
  }

  frame(time) {
    const delta = Math.min((time - this.lastTime) / 1000, 0.05);
    this.lastTime = time;
    this.update(delta);
    this.render(delta);
    requestAnimationFrame((nextTime) => this.frame(nextTime));
  }

  update(delta) {
    this.noiseTime += delta;
    this.player?.update(delta, this.room, this.actors);
    this.actors.forEach((actor) => actor.update(delta, this.room));
    if (this.fadeDirection !== 0) {
      this.fade = clamp(this.fade + this.fadeDirection * delta * 1.75, 0, 1);
    }
  }

  render(delta) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    this.drawLayer('background');
    this.drawDecals();
    this.drawActors();
    this.drawLayer('foreground');
    this.drawOverlays(delta);
    this.drawFade();
  }

  drawLayer(name) {
    const image = this.images[name];
    if (!image) return;
    this.ctx.drawImage(image, 0, 0, this.width, this.height);
  }

  drawDecals() {
    const actors = [this.player, ...this.actors].filter(Boolean);
    actors.forEach((actor) => {
      const scale = actor.getScale(this.room);
      this.ctx.save();
      this.ctx.globalAlpha = 0.28;
      this.ctx.fillStyle = '#000';
      this.ctx.beginPath();
      this.ctx.ellipse(actor.x, actor.y + 18 * scale, 38 * scale, 10 * scale, 0, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.restore();
    });
  }

  drawActors() {
    [this.player, ...this.actors]
      .filter(Boolean)
      .sort((a, b) => a.y - b.y)
      .forEach((actor) => actor.draw(this.ctx, this.room));
  }

  drawOverlays(delta) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.08 + Math.sin(this.noiseTime * 9) * 0.018;
    ctx.fillStyle = '#d8c2a3';
    for (let i = 0; i < 28; i += 1) {
      const x = (Math.sin(this.noiseTime * 0.7 + i * 71.3) * 0.5 + 0.5) * this.width;
      const y = ((this.noiseTime * 18 + i * 83) % this.height);
      ctx.fillRect(x, y, 2, 2);
    }
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = '#000';
    for (let y = 0; y < this.height; y += 4) {
      ctx.fillRect(0, y, this.width, 1);
    }
    ctx.restore();
  }

  drawFade() {
    if (this.fade <= 0) return;
    this.ctx.save();
    this.ctx.globalAlpha = this.fade;
    this.ctx.fillStyle = '#020202';
    this.ctx.fillRect(0, 0, this.width, this.height);
    this.ctx.restore();
  }

  handleClick(event) {
    const point = this.toRoomPoint(event);
    const hotspot = this.findRectHit(point, this.room.hotspots);
    if (hotspot) {
      if (hotspot.interaction?.voice) this.playVoice(hotspot.interaction.voice);
      this.message = hotspot.interaction?.text || `Nothing useful about ${hotspot.label}.`;
      this.player.walkTo(this.getRectAnchor(hotspot.rect));
      this.updateUI(hotspot.label);
      return;
    }

    const exit = this.findRectHit(point, this.room.exits);
    if (exit) {
      this.player.walkTo(this.getRectAnchor(exit.rect), () => this.transitionTo(exit.targetRoom, exit.targetSpawn));
      this.message = 'Romeo heads for the next bad idea.';
      this.updateUI(exit.id);
      return;
    }

    if (isPointInPolygon([point.x, point.y], this.room.walkArea)) {
      this.player.walkTo(point);
      this.message = 'The floor accepts the plan.';
    } else {
      this.message = 'Romeo studies the route. No.';
    }
    this.updateUI();
  }

  async transitionTo(roomId, spawnId) {
    this.fadeDirection = 1;
    await wait(650);
    await this.loadRoom(roomId, spawnId);
    this.fade = 1;
    this.fadeDirection = -1;
    await wait(650);
    this.fadeDirection = 0;
    this.fade = 0;
  }

  toRoomPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: clamp(((event.clientX - rect.left) / rect.width) * this.width, 0, this.width),
      y: clamp(((event.clientY - rect.top) / rect.height) * this.height, 0, this.height),
    };
  }

  findRectHit(point, entries) {
    return entries.find((entry) => {
      const [x, y, width, height] = entry.rect;
      return point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height;
    });
  }

  getVoiceBasePath(voiceId) {
    if (!this.room?.id || !voiceId) return null;
    return `rooms/${this.room.id}/voice/${voiceId}`;
  }

  tryVoiceExtension(voiceId, extensionIndex = 0) {
    if (!this.audio || extensionIndex >= this.voiceExtensions.length) return;
    const basePath = this.getVoiceBasePath(voiceId);
    if (!basePath) return;
    const src = `${basePath}.${this.voiceExtensions[extensionIndex]}`;
    this.audio.pause();
    this.audio.currentTime = 0;
    this.audio.src = src;
    this.audio.onerror = () => this.tryVoiceExtension(voiceId, extensionIndex + 1);
    this.audio.play().catch(() => {
      // Ignore autoplay failures; voice can be retried on next interaction.
    });
  }

  playVoice(voiceId) {
    if (!voiceId) return;
    this.tryVoiceExtension(voiceId, 0);
  }

  getRectAnchor(rect) {
    return {
      x: rect[0] + rect[2] / 2,
      y: rect[1] + rect[3] + 26,
    };
  }

  updateUI(focus = '') {
    this.ui.room.textContent = this.room.displayName;
    this.ui.focus.textContent = focus || 'No focus';
    this.ui.message.textContent = this.message;
  }
}

class ScreenActor {
  constructor(config) {
    this.id = config.id;
    this.label = config.label || config.id;
    this.type = config.type || 'npc';
    this.x = config.x;
    this.y = config.y;
    this.target = null;
    this.onArrive = null;
    this.facing = config.facing || 'down';
    this.color = config.color || (this.type === 'zombie' ? '#363734' : '#20272d');
    this.coat = config.coat || (this.type === 'zombie' ? '#1f2421' : '#111');
    this.speed = config.speed || (this.type === 'zombie' ? 42 : 110);
    this.scaleMin = config.scaleMin || 0.58;
    this.scaleMax = config.scaleMax || 1.1;
    this.phase = Math.random() * Math.PI * 2;
    this.state = config.state || 'idle';
    this.patrol = config.patrol || null;
    this.patrolIndex = 0;
    if (this.patrol) this.walkTo(this.patrol[0]);
  }

  walkTo(point, onArrive = null) {
    this.target = { x: point.x, y: point.y };
    this.onArrive = onArrive;
    this.state = 'walk';
  }

  update(delta, room, blockers = []) {
    if (!this.target) {
      this.state = 'idle';
      return;
    }

    const dx = this.target.x - this.x;
    const dy = this.target.y - this.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= 4) {
      this.x = this.target.x;
      this.y = this.target.y;
      this.target = null;
      this.state = 'idle';
      const callback = this.onArrive;
      this.onArrive = null;
      if (callback) callback();
      if (this.patrol) {
        this.patrolIndex = (this.patrolIndex + 1) % this.patrol.length;
        window.setTimeout(() => this.walkTo(this.patrol[this.patrolIndex]), 1200);
      }
      return;
    }

    const step = Math.min(this.speed * delta, distance);
    const previousX = this.x;
    const previousY = this.y;
    this.x += (dx / distance) * step;
    this.y += (dy / distance) * step;
    this.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    if (!isPointInPolygon([this.x, this.y], room.walkArea) || this.isBlockedByActor(blockers, previousX, previousY)) {
      this.x = previousX;
      this.y = previousY;
      this.target = null;
      this.state = 'idle';
    }
  }

  isBlockedByActor(blockers, previousX, previousY) {
    if (this.type !== 'player') return false;
    return blockers.some((actor) => {
      if (!actor || actor === this) return false;
      const minDistance = this.getCollisionRadius() + actor.getCollisionRadius();
      const nextDistance = Math.hypot(this.x - actor.x, this.y - actor.y);
      if (nextDistance >= minDistance) return false;
      const previousDistance = Math.hypot(previousX - actor.x, previousY - actor.y);
      return nextDistance < previousDistance;
    });
  }

  getCollisionRadius() {
    return this.type === 'player' ? 34 : 42;
  }

  getScale(room) {
    const yValues = room.walkArea.map((point) => point[1]);
    const minY = Math.min(...yValues);
    const maxY = Math.max(...yValues);
    const t = clamp((this.y - minY) / Math.max(maxY - minY, 1), 0, 1);
    return lerp(this.scaleMin, this.scaleMax, t);
  }

  draw(ctx, room) {
    const scale = this.getScale(room);
    const bob = this.state === 'walk' ? Math.sin(performance.now() * 0.012 + this.phase) * 3 : 0;
    const w = 32 * scale;
    const h = 86 * scale;
    ctx.save();
    ctx.translate(this.x, this.y + bob);
    ctx.imageSmoothingEnabled = false;

    ctx.fillStyle = this.coat;
    ctx.fillRect(-w * 0.48, -h * 0.72, w * 0.96, h * 0.55);
    ctx.fillStyle = '#1b1d20';
    ctx.fillRect(-w * 0.44, -h * 0.18, w * 0.32, h * 0.48);
    ctx.fillRect(w * 0.12, -h * 0.18, w * 0.32, h * 0.48);
    ctx.fillStyle = this.type === 'zombie' ? '#8b8175' : '#b79b7d';
    ctx.fillRect(-w * 0.26, -h, w * 0.52, h * 0.25);
    ctx.fillStyle = this.color;
    ctx.fillRect(-w * 0.55, -h * 0.66, w * 0.22, h * 0.48);
    ctx.fillRect(w * 0.33, -h * 0.66, w * 0.22, h * 0.48);

    if (this.type === 'zombie') {
      ctx.fillStyle = '#5d1f1f';
      ctx.fillRect(w * 0.18, -h * 0.58, w * 0.18, h * 0.12);
    }

    ctx.restore();
  }
}

function loadImage(src) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

function isPointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    const intersects = ((yi > point[1]) !== (yj > point[1]))
      && (point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

const engine = new LayeredRoomRenderer(document.getElementById('room-canvas'), {
  room: document.getElementById('ui-room'),
  focus: document.getElementById('ui-focus'),
  message: document.getElementById('ui-message'),
});

engine.start();
