import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.152.2/build/three.module.js';
import { FBXLoader } from 'https://cdn.jsdelivr.net/npm/three@0.152.2/examples/jsm/loaders/FBXLoader.js';
import { AnimationLibrary, ActorAnimator } from './animation.js?v=pathfinding-1';
import { TankMovementController } from './movement.js?v=ctrl-shoot-1';
import { NPC } from './npc.js?v=pathfinding-1';
import { strFromU8, unzipSync } from 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js';

const ITEM_DATABASE = {
  small_key: {
    id: 'small_key',
    name: 'Small Key',
    description: 'A small brass key hidden between old books.',
    icon: '⚿',
    type: 'key',
  },
  lighter: {
    id: 'lighter',
    name: 'Lighter',
    description: 'Almost empty. Still warmer than the room.',
    icon: '▴',
    type: 'tool',
  },
  screwdriver: {
    id: 'screwdriver',
    name: 'Screwdriver',
    description: 'Flathead. Old handle. Useful enough.',
    icon: '⌐',
    type: 'tool',
    slotCost: 1,
    useOnWorld: ['car_panel', 'fuse_box_cover'],
  },
  fuse: {
    id: 'fuse',
    name: 'Fuse',
    description: 'A small fuse for an old electrical panel.',
    icon: '▪',
    type: 'part',
    slotCost: 1,
    consumable: true,
    useOnWorld: ['fuse_box'],
  },
  crowbar: {
    id: 'crowbar',
    name: 'Crowbar',
    description: 'Heavy, ugly, persuasive.',
    icon: '∫',
    type: 'tool',
    slotCost: 1,
    useOnWorld: ['car_hood', 'jammed_locker'],
  },
  car_keys: {
    id: 'car_keys',
    name: 'Car Keys',
    description: 'Keys to something that may no longer mean escape.',
    icon: '⚿',
    type: 'key',
  },
  shotgun_shells: {
    id: 'shotgun_shells',
    name: 'Shotgun Shells',
    description: 'A few shells. Too few to feel safe.',
    icon: '▪',
    type: 'ammo',
    quantity: 2,
    slotCost: 1,
  },
  gasoline_can: {
    id: 'gasoline_can',
    name: 'Gasoline Can',
    description: 'Full enough to matter. Heavy enough to make Romeo careful.',
    icon: '▰',
    type: 'puzzle',
    slotCost: 3,
    weight: 4,
    behaviors: {
      isBulky: true,
      twoHanded: true,
      restrictActions: ['shoot', 'melee', 'run', 'climb'],
      slowsMovement: true,
      makeNoise: true,
    },
    useOnWorld: ['escape_car', 'fuel_cap'],
  },
};

const GameState = {
  player: {
    health: 100,
    maxHealth: 100,
    inventory: [],
    noiseLevel: 0,
    carryingItem: null,
  },
  currentRoom: 'placeholderRoom',
  items: ITEM_DATABASE,
  flags: {
    hasInvestigatedBox: false,
    doorOpened: false,
    carInspected: false,
    carHoodOpen: false,
    carPanelOpen: false,
    carFuseInstalled: false,
    carFueled: false,
    carFixed: false,
    carryHintShown: false,
  },
  getItem(itemId) {
    return this.player.inventory.find((item) => item?.id === itemId) || null;
  },
  hasItem(itemId) {
    return Boolean(this.getItem(itemId));
  },
  getInventoryUsedSlots() {
    return this.player.inventory.reduce((total, item) => total + (item?.slotCost || 1), 0);
  },
  canAddItem(itemId) {
    const template = typeof itemId === 'string' ? this.items[itemId] : itemId;
    if (!template) return false;
    if (!template.allowDuplicates && this.hasItem(template.id)) return false;
    return this.getInventoryUsedSlots() + (template.slotCost || 1) <= InventorySystem.maxSlots;
  },
  addItem(itemOrId) {
    const template = typeof itemOrId === 'string' ? this.items[itemOrId] : itemOrId;
    if (!template?.id) {
      console.warn('Missing item data:', itemOrId);
      return false;
    }
    if (!template.allowDuplicates && this.hasItem(template.id)) {
      InventorySystem.refresh();
      return false;
    }
    if (this.getInventoryUsedSlots() + (template.slotCost || 1) > InventorySystem.maxSlots) {
      NarratorVoice.speak('Romeo has no room for anything else.', [{ label: 'Continue', action: () => { } }]);
      return false;
    }
    this.player.inventory.push({ ...template });
    InventorySystem.refresh();
    return true;
  },
  removeItem(itemId) {
    const index = this.player.inventory.findIndex((item) => item?.id === itemId);
    if (index < 0) return false;
    this.player.inventory.splice(index, 1);
    InventorySystem.refresh();
    return true;
  },
  setFlag(flagId, value = true) {
    if (!flagId) return;
    this.flags[flagId] = value;
  },
  hasFlag(flagId) {
    return Boolean(this.flags[flagId]);
  },
  damagePlayer(amount, source = {}) {
    const damage = Math.max(0, Number(amount) || 0);
    if (!damage) return false;
    this.player.health = Math.max(0, this.player.health - damage);
    this.updatePlayerHealthUI();
    this.setFlag('player_damaged');
    if (this.player.health <= 0) this.setFlag('player_down');
    console.info(`Romeo takes ${damage} damage from ${source.id || source.label || 'danger'}. Health: ${this.player.health}`);
    return true;
  },
  healPlayer(amount) {
    const healing = Math.max(0, Number(amount) || 0);
    if (!healing) return false;
    this.player.health = Math.min(this.player.maxHealth, this.player.health + healing);
    this.updatePlayerHealthUI();
    return true;
  },
  updatePlayerHealthUI() {
    const value = document.getElementById('player-health');
    const row = value?.closest('.player-health-row');
    if (!value) return;
    const health = Math.round(this.player.health);
    const maxHealth = Math.round(this.player.maxHealth || 100);
    value.textContent = `${health}/${maxHealth}`;
    row?.classList.toggle('is-hurt', health < maxHealth);
    row?.classList.toggle('is-critical', health <= maxHealth * 0.3);
  },
  startCarry(itemOrId) {
    const item = typeof itemOrId === 'string' ? this.getItem(itemOrId) || this.items[itemOrId] : itemOrId;
    if (!item) return false;
    this.player.carryingItem = { ...item };
    InventorySystem.refresh();
    return true;
  },
  stopCarry() {
    this.player.carryingItem = null;
    InventorySystem.refresh();
  },
  isCarryingTwoHanded() {
    return Boolean(this.player.carryingItem?.behaviors?.twoHanded);
  },
  canUseCombat() {
    return !this.isCarryingTwoHanded();
  },
  checkCarFixed() {
    const fixed = this.flags.carHoodOpen
      && this.flags.carPanelOpen
      && this.flags.carFuseInstalled
      && this.flags.carFueled;
    if (fixed && !this.flags.carFixed) {
      this.setFlag('carFixed', true);
      return true;
    }
    return false;
  },
  setRoom(roomId, spawnId = null) {
    const previousRoom = this.currentRoom;
    this.currentRoom = roomId;
    RoomManager.enterRoom(roomId, spawnId);
    if (!RoomManager.currentRoom) {
      console.warn(`Room not found: ${roomId}`);
      this.currentRoom = previousRoom;
      return false;
    }
    document.getElementById('room-name').textContent = RoomManager.currentRoom?.name || 'Unknown';
    return true;
  },
};

const RoomManager = {
  renderer: null,
  currentRoom: null,
  rooms: {},
  roomManifest: {
    apt_708_entry: './rooms/apt_708_entry/room.json',
    hallway_7f: './rooms/hallway_7f/room.json',
    basement_storage: './rooms/basement_storage/room.json',
    garage_workshop: './rooms/garage_workshop/room.json',
    old_kitchen: './rooms/old_kitchen/room.json',
    street: './rooms/street/room.json',
    street_to_downtown: './rooms/street_to_downtown/room.json',
    downtown_swarm: './rooms/downtown_swarm/room.json',
  },
  hybridRoomData: null,
  hallwayRoomData: null,
  roomDataById: {},
  roomPackages: {},
  assetPackages: {},
  hybridWalkMask: null,
  hybridInterestMap: null,
  roomMaps: {},
  navGrids: {},
  currentPathDebug: null,
  hoverInterestId: null,
  debugWalkMaskOverlay: null,
  raycaster: new THREE.Raycaster(),
  pointer: new THREE.Vector2(),
  walkSurfaceY: 0,
  walkPlaneSlopeZ: 0,
  walkPlaneOffsetY: 0,
  walkPlaneConfig: null,
  walkPlane: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
  character: null,
  characterModel: null,
  characterHeadBone: null,
  characterHeadBaseRotation: null,
  characterRightHandBone: null,
  weaponModel: null,
  weaponRoot: null,
  weaponMuzzle: null,
  weaponConfig: {
    path: 'Models/glock.fbx',
    textureFolder: 'glock',
    scale: 0.012,
    position: [0.055, 0.02, 0.035],
    rotation: [-1.5708, 0, 1.5708],
    muzzlePosition: [0, 0, 0.34],
  },
  characterAnimator: null,
  characterAnimationState: null,
  characterInteractionAnimationUntil: 0,
  characterAnimationPromises: {},
  characterAnimationPaths: {
    idle: './Animation/idle.fbx',
    walk: './Animation/walk.fbx',
    backpedal: './Animation/Walk Backward.fbx',
    carry_idle: './Animation/carry_idle.fbx',
    carry_walk: './Animation/carry_walk.fbx',
    aim: './Animation/Shoot.fbx',
  },
  characterAnimationSpeeds: {
    idle: 1,
    walk: 1.75,
    backpedal: 1.15,
    carry_idle: 1,
    carry_walk: 1,
    pickup: 1,
  },
  characterAimPoseTime: 0.82,
  animationLibrary: new AnimationLibrary(),
  npcAnimationLibrary: new AnimationLibrary(),
  npcs: [],
  placedModels: [],
  placedModelPromises: new Map(),
  damageCooldowns: new Map(),
  cinematicActive: false,
  driveParallax: null,
  driveOverlay: null,
  npcAnimationPromise: null,
  pendingActorStates: {},
  characterCollisionRadius: 0.78,
  characterHeightScale: 0.98,
  npcCollisionRadius: 1,
  characterSpeed: 1.8,
  characterTurnSpeed: Math.PI * 1.7,
  characterVisualRotation: new THREE.Euler(-Math.PI / 2, 0, Math.PI),
  characterVisualMirrorY: false,
  hybridRoomLayerPaths: {
    background: './rooms/apt_708_entry/bg.svg',
    foreground: './rooms/apt_708_entry/fg.svg',
  },
  hybridComposition: {
    baseLayerSize: new THREE.Vector2(18.4, 10.35),
    roomZoom: 1,
    doorWorldHeight: 3.6,
    actorDoorRatio: 0.33,
    calibratedActorHeight: null,
    npcScale: 1,
    propScale: 0.78,
    backgroundExposure: 1,
    foregroundOpacity: 1,
    backgroundTint: '#ffffff',
    backgroundTintStrength: 0,
  },
  hybridLighting: {
    ambientColor: 0x38414a,
    ambientIntensity: 0.62,
    practicalColor: 0xffc18a,
    practicalIntensity: 1.45,
    practicalPosition: new THREE.Vector3(-2.5, 1.35, 0.75),
    windowColor: 0x8fa8c4,
    windowIntensity: 0.82,
    windowPosition: new THREE.Vector3(-0.35, 2.8, -3.2),
    rimColor: 0xd8e6ff,
    rimIntensity: 0.45,
    rimPosition: new THREE.Vector3(2.9, 2.0, -2.4),
    fogColor: 0x040408,
    fogNear: 4,
    fogFar: 13,
    clearColor: 0x050506,
  },
  headLook: {
    x: 0,
    y: 0,
    blend: 0.48,
    maxYaw: THREE.MathUtils.degToRad(38),
    maxPitch: THREE.MathUtils.degToRad(24),
    smoothing: 14,
    deadZone: 0.18,
    verticalBias: 0,
    neutralPitch: THREE.MathUtils.degToRad(-26),
    yawAxis: 'y',
    pitchAxis: 'x',
    yawSign: 1,
    pitchSign: 1,
    yawOffset: 0,
    pitchOffset: 0,
  },
  async init(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    this.renderer.setPixelRatio(0.5);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x040408);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    window.addEventListener('resize', () => this.onResize());

    await this.loadAssetPackages();
    this.animationLibrary.setURLResolver((url) => this.getGlobalAssetPath(url));
    this.npcAnimationLibrary.setURLResolver((url) => this.getGlobalAssetPath(url));
    await this.loadAllRoomData();
    this.hybridRoomData = this.roomDataById.apt_708_entry;
    this.hallwayRoomData = this.roomDataById.hallway_7f;
    this.applyHybridRoomSettings(this.hybridRoomData);
    await this.loadRoomMaps();
    this.hybridWalkMask = this.roomMaps.apt_708_entry.walkMask;
    this.hybridInterestMap = this.roomMaps.apt_708_entry.interestMap;
    window.DEBUG_WALK = () => ({
      roomId: this.hybridRoomData?.id,
      walkArea: this.hybridRoomData?.walkArea,
      walkObstacles: this.hybridRoomData?.walkObstacles,
      walkBounds: this.hybridRoomData?.hybrid3d?.walkBounds,
      movementBounds: this.getMovementBounds(),
      walkSurfaceY: this.walkSurfaceY,
      walkPlaneSlopeZ: this.walkPlaneSlopeZ,
      walkPlaneOffsetY: this.walkPlaneOffsetY,
      walkMask: this.hybridWalkMask ? {
        width: this.hybridWalkMask.canvas.width,
        height: this.hybridWalkMask.canvas.height,
        mode: this.hybridWalkMask.mode,
        walkableBounds: this.hybridWalkMask.walkableBounds,
      } : null,
      characterWalkable: this.character ? this.isWorldPositionWalkable(this.character.position) : null,
      characterWorld: this.character ? {
        x: this.character.position.x,
        y: this.character.position.y,
        z: this.character.position.z,
      } : null,
      characterRoomPixel: this.character ? this.getRoomPixelFromWorldPosition(this.character.position) : null,
      plateRect: this.getRoomPlateScreenRect(),
    });
    window.DEBUG_WALK_AT = (x, y) => this.debugWalkMaskAt(x, y);
    window.DEBUG_WALK_WORLD = (x, z) => this.debugWalkMaskWorld(x, z);
    window.DEBUG_WORLD_FROM_PIXEL = (x, y) => this.debugWorldFromRoomPixel(x, y);
    window.DEBUG_INTEREST_AT = (x, y) => this.debugInterestAt(x, y);
    window.DEBUG_PLAYER_START = () => this.debugPlayerStart();
    window.DEBUG_NPCS = () => this.debugActorSpacing();
    window.DEBUG_ROOMS = () => this.debugRooms();
    window.DEBUG_PATH = () => this.currentPathDebug;
    window.DEBUG_NAVGRID = () => {
      const grid = this.buildNavigationGrid();
      return grid ? {
        roomId: grid.roomId,
        cellSize: grid.cellSize,
        cols: grid.cols,
        rows: grid.rows,
        walkableCount: grid.walkableCount,
        total: grid.walkable.length,
      } : null;
    };
    window.DEBUG_PATH_FROM_TO = (sx, sy, gx, gy) => {
      const rawPath = this.findPathRoomPixels({ x: sx, y: sy }, { x: gx, y: gy });
      const path = rawPath ? this.simplifyPath(rawPath) : null;
      return { rawPath, path };
    };
    window.DEBUG_ENTER_ROOM = (roomId, spawnId = null) => {
      GameState.setRoom(roomId, spawnId);
      return this.debugRooms()[roomId] || null;
    };
    window.DEBUG_SCALE = () => this.debugActorScale();
    window.RoomManager = this;
    window.DEBUG_DRAW_WALKMASK = false;
    this.createRoomsFromLoadedData();
    this.rooms.hallwayRoom = this.rooms.hallway_7f;
    this.setCameraForRoom(this.rooms.apt_708_entry);
    GameState.currentRoom = 'apt_708_entry';
    this.enterRoom('apt_708_entry');
  },

  async loadAllRoomData() {
    const entries = await Promise.all(
      Object.keys(this.roomManifest).map(async (roomId) => [roomId, await this.loadRoomJson(roomId)])
    );
    this.roomDataById = {};
    entries.forEach(([roomId, roomData]) => {
      if (roomData) this.roomDataById[roomId] = roomData;
    });
  },

  async loadRoomMaps() {
    const entries = await Promise.all(
      Object.entries(this.roomDataById).map(async ([roomId, roomData]) => [roomId, {
        walkMask: await this.loadWalkMask(roomData),
        interestMap: await this.loadPixelMap(roomData?.layers?.interestMap, roomData, 'interest map'),
      }])
    );
    this.roomMaps = Object.fromEntries(entries);
  },

  createRoomsFromLoadedData() {
    this.rooms = {};
    Object.entries(this.roomDataById).forEach(([roomId, roomData]) => {
      const previousRoomData = this.hybridRoomData;
      this.hybridRoomData = roomData;
      this.applyHybridRoomSettings(roomData);
      const room = roomId === 'apt_708_entry'
        ? this.createPlaceholderRoom()
        : this.createPrerenderedRoom(roomData);
      this.hybridRoomData = previousRoomData;
      this.attachRoomMaps(room, roomData);
      this.rooms[roomId] = room;
    });
    this.rooms.placeholderRoom = this.rooms.apt_708_entry;
  },

  getRoomManifestEntry(roomId) {
    const entry = this.roomManifest[roomId];
    if (!entry) return null;
    if (typeof entry === 'string') {
      if (/\.zip$/i.test(entry)) {
        return {
          json: `./rooms/${roomId}/room.json`,
          zip: entry,
        };
      }
      const json = entry;
      return {
        json,
        zip: json.replace(/\/room\.json$/i, '.zip'),
      };
    }
    const folder = entry.folder || `./rooms/${roomId}`;
    return {
      json: entry.json || `${folder.replace(/\/$/, '')}/room.json`,
      zip: entry.zip || `${folder.replace(/\/$/, '')}.zip`,
    };
  },

  loadWalkMask(roomData) {
    const maskSrc = roomData?.layers?.walkMask;
    if (!maskSrc) return Promise.resolve(null);
    const maskUrl = this.getRoomAssetPath(roomData, maskSrc);

    return new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = roomData.camera?.width || image.naturalWidth || 1920;
        canvas.height = roomData.camera?.height || image.naturalHeight || 1080;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const mode = this.getWalkMaskMode(roomData);
        resolve({
          canvas,
          context,
          mode,
          walkableBounds: this.getWalkMaskWalkableBounds(canvas, context, mode),
        });
      };
      image.onerror = () => {
        console.warn(`Failed to load walk mask: ${maskSrc}`);
        resolve(null);
      };
      image.src = this.withCacheBust(maskUrl);
    });
  },

  loadPixelMap(src, roomData, label = 'pixel map') {
    if (!src) return Promise.resolve(null);
    const mapUrl = this.getRoomAssetPath(roomData, src);

    return new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = roomData.camera?.width || image.naturalWidth || 1920;
        canvas.height = roomData.camera?.height || image.naturalHeight || 1080;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve({ canvas, context });
      };
      image.onerror = () => {
        console.warn(`Failed to load ${label}: ${src}`);
        resolve(null);
      };
      image.src = this.withCacheBust(mapUrl);
    });
  },

  attachRoomMaps(room, roomData) {
    if (!room || !roomData?.id) return;
    room.walkMask = this.roomMaps[roomData.id]?.walkMask || null;
    room.interestMap = this.roomMaps[roomData.id]?.interestMap || null;
  },

  activateRoomData(room) {
    if (!room?.roomData) return;
    this.hybridRoomData = room.roomData;
    this.hybridWalkMask = room.walkMask || null;
    this.hybridInterestMap = room.interestMap || null;
    this.applyHybridRoomSettings(room.roomData);
    this.applyRoomLightingProfile(room.roomData, room.scene);
  },

  async loadRoomJson(roomId) {
    const manifest = this.getRoomManifestEntry(roomId);
    if (!manifest) return null;
    try {
      const response = await fetch(this.withCacheBust(manifest.json), { cache: 'no-store' });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const roomData = await response.json();
      this.roomPackages[roomId] = {
        type: 'folder',
        roomId,
        json: manifest.json,
        zip: manifest.zip,
        assetUrls: {},
      };
      return roomData;
    } catch (error) {
      return this.loadRoomZip(roomId, manifest, error);
    }
  },

  async loadRoomZip(roomId, manifest, folderError) {
    try {
      const response = await fetch(this.withCacheBust(manifest.zip), { cache: 'no-store' });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const archive = unzipSync(new Uint8Array(await response.arrayBuffer()));
      const jsonEntryName = this.findZipEntryName(archive, 'room.json');
      if (!jsonEntryName) throw new Error('room.json missing from zip');
      const roomData = JSON.parse(strFromU8(archive[jsonEntryName]));
      this.roomPackages[roomId] = {
        type: 'zip',
        roomId,
        json: jsonEntryName,
        zip: manifest.zip,
        assetUrls: this.createZipAssetUrls(roomId, archive),
      };
      return roomData;
    } catch (zipError) {
      console.warn(`Failed to load room "${roomId}" from folder or zip.`, { folderError, zipError });
      return null;
    }
  },

  findZipEntryName(archive, requestedPath) {
    const requested = this.normalizeAssetKey(requestedPath);
    return Object.keys(archive).find((name) => this.normalizeAssetKey(name) === requested)
      || Object.keys(archive).find((name) => this.normalizeAssetKey(name).endsWith(`/${requested}`));
  },

  createZipAssetUrls(roomId, archive) {
    const urls = {};
    const entries = Object.entries(archive).filter(([name, data]) => data && !name.endsWith('/'));
    entries
      .filter(([name]) => !name.toLowerCase().endsWith('.svg'))
      .forEach(([name, data]) => {
        const blob = new Blob([data], { type: this.getMimeType(name) });
        const url = URL.createObjectURL(blob);
        this.getZipAssetKeys(roomId, name).forEach((key) => {
          urls[key] = url;
        });
      });
    entries
      .filter(([name]) => name.toLowerCase().endsWith('.svg'))
      .forEach(([name, data]) => {
        const svg = strFromU8(data).replace(
          /((?:href|xlink:href)=["'])([^"']+)(["'])/gi,
          (match, prefix, href, suffix) => {
            if (/^(data:|blob:|https?:\/\/|\/\/|#)/i.test(href)) return match;
            const url = this.resolveZipRelativeAssetUrl(roomId, name, href, urls);
            return url ? `${prefix}${url}${suffix}` : match;
          }
        );
        const blob = new Blob([svg], { type: this.getMimeType(name) });
        const url = URL.createObjectURL(blob);
        this.getZipAssetKeys(roomId, name).forEach((key) => {
          urls[key] = url;
        });
      });
    return urls;
  },

  async loadAssetPackages() {
    await Promise.all([
      this.loadAssetPackage('models', './models.zip'),
      this.loadAssetPackage('animation', './animation.zip'),
    ]);
  },

  async loadAssetPackage(name, zipPath) {
    try {
      const response = await fetch(this.withCacheBust(zipPath), { cache: 'no-store' });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const archive = unzipSync(new Uint8Array(await response.arrayBuffer()));
      this.assetPackages[name] = {
        zip: zipPath,
        assetUrls: this.createAssetPackageUrls(archive),
      };
    } catch (error) {
      console.warn(`Failed to load ${zipPath}; falling back to loose asset files.`, error);
      this.assetPackages[name] = {
        zip: zipPath,
        assetUrls: {},
      };
    }
  },

  createAssetPackageUrls(archive) {
    const urls = {};
    Object.entries(archive)
      .filter(([name, data]) => data && !name.endsWith('/'))
      .forEach(([name, data]) => {
        const blob = new Blob([data], { type: this.getMimeType(name) });
        const url = URL.createObjectURL(blob);
        this.getAssetPackageKeys(name).forEach((key) => {
          urls[key] = url;
        });
      });
    return urls;
  },

  getAssetPackageKeys(path) {
    const key = this.normalizeAssetKey(path);
    const keys = new Set([key]);
    const topLevelIndex = key.indexOf('/');
    if (topLevelIndex >= 0) keys.add(key.slice(topLevelIndex + 1));
    if (!key.includes('/')) {
      keys.add(`Models/${key}`);
      keys.add(`Animation/${key}`);
    }
    return [...keys].filter(Boolean);
  },

  resolveZipRelativeAssetUrl(roomId, ownerPath, href, urls) {
    const ownerKey = this.normalizeAssetKey(ownerPath);
    const ownerDir = ownerKey.includes('/') ? ownerKey.slice(0, ownerKey.lastIndexOf('/') + 1) : '';
    const hrefKey = this.normalizeAssetKey(href);
    const candidates = [
      this.normalizeAssetKey(`${ownerDir}${hrefKey}`),
      hrefKey,
      hrefKey.split('/').pop(),
      `rooms/${roomId}/${hrefKey}`,
    ];
    for (const candidate of candidates) {
      if (urls[candidate]) return urls[candidate];
    }
    return null;
  },

  getZipAssetKeys(roomId, path) {
    const key = this.normalizeAssetKey(path);
    const filename = key.split('/').pop();
    const roomPrefix = `rooms/${roomId}/`;
    const keys = new Set([key, filename]);
    if (key.startsWith(roomPrefix)) keys.add(key.slice(roomPrefix.length));
    const roomIndex = key.lastIndexOf(`${roomId}/`);
    if (roomIndex >= 0) keys.add(key.slice(roomIndex + roomId.length + 1));
    return [...keys].filter(Boolean);
  },

  normalizeAssetKey(path) {
    return String(path || '')
      .replace(/^blob:/, 'blob:')
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/^\/+/, '');
  },

  getMimeType(path) {
    const extension = String(path).split('.').pop()?.toLowerCase();
    return {
      json: 'application/json',
      svg: 'image/svg+xml',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      wav: 'audio/wav',
      mp3: 'audio/mpeg',
      ogg: 'audio/ogg',
      fbx: 'application/octet-stream',
    }[extension] || 'application/octet-stream';
  },

  getRoomAssetPath(roomData, path) {
    if (!path || typeof path !== 'string') return null;
    if (/^(blob:|https?:\/\/|\/\/|\.\.?\/)/i.test(path)) return path;
    const roomId = roomData?.id;
    const packageInfo = roomId ? this.roomPackages[roomId] : null;
    if (packageInfo?.type === 'zip') {
      const normalized = this.normalizeAssetKey(path);
      const roomRelative = normalized.startsWith(`rooms/${roomId}/`)
        ? normalized.slice(`rooms/${roomId}/`.length)
        : normalized;
      const filename = normalized.split('/').pop();
      return packageInfo.assetUrls[normalized]
        || packageInfo.assetUrls[roomRelative]
        || packageInfo.assetUrls[filename]
        || this.getAssetPath(path);
    }
    return this.getAssetPath(path);
  },

  withCacheBust(src) {
    if (!src || /^blob:/i.test(src)) return src;
    return `${src}${src.includes('?') ? '&' : '?'}v=${Date.now()}`;
  },

  applyHybridRoomSettings(roomData) {
    const hybrid = roomData?.hybrid3d;
    if (!hybrid) return;

    if (hybrid.layers?.background) this.hybridRoomLayerPaths.background = this.getRoomAssetPath(roomData, hybrid.layers.background);
    if (hybrid.layers?.foreground) this.hybridRoomLayerPaths.foreground = this.getRoomAssetPath(roomData, hybrid.layers.foreground);

    const composition = hybrid.composition || {};
    if (Array.isArray(composition.baseLayerSize)) {
      this.hybridComposition.baseLayerSize.set(composition.baseLayerSize[0], composition.baseLayerSize[1]);
    }
    [
      'roomZoom',
      'doorWorldHeight',
      'actorDoorRatio',
      'npcScale',
      'propScale',
      'backgroundExposure',
      'foregroundOpacity',
      'backgroundTintStrength',
    ].forEach((key) => {
      if (Number.isFinite(composition[key])) this.hybridComposition[key] = composition[key];
    });
    this.hybridComposition.backgroundTint = typeof composition.backgroundTint === 'string'
      ? composition.backgroundTint
      : '#ffffff';
    this.hybridComposition.backgroundTintStrength = Number.isFinite(composition.backgroundTintStrength)
      ? composition.backgroundTintStrength
      : 0;
    this.applyHybridLightingSettings(hybrid.lighting);
    this.walkPlaneConfig = hybrid.walkPlaneFromRoomPixels || null;
    this.setHorizontalWalkSurface(Number.isFinite(hybrid.walkSurfaceY) ? hybrid.walkSurfaceY : 0);
    this.hybridComposition.calibratedActorHeight = null;
  },

  setHorizontalWalkSurface(y) {
    this.walkSurfaceY = y;
    this.walkPlaneSlopeZ = 0;
    this.walkPlaneOffsetY = y;
    this.walkPlane.set(new THREE.Vector3(0, 1, 0), -y);
  },

  setTiltedWalkSurface(slopeZ, offsetY) {
    this.walkPlaneSlopeZ = slopeZ;
    this.walkPlaneOffsetY = offsetY;
    this.walkSurfaceY = offsetY;
    const normal = new THREE.Vector3(0, 1, -slopeZ);
    const length = normal.length();
    normal.divideScalar(length);
    this.walkPlane.set(normal, -offsetY / length);
  },

  getWalkSurfaceYAt(position = null) {
    const z = Number.isFinite(position?.z) ? position.z : 0;
    return this.walkPlaneSlopeZ * z + this.walkPlaneOffsetY;
  },

  applyHybridLightingSettings(lighting = {}) {
    [
      'ambientIntensity',
      'practicalIntensity',
      'windowIntensity',
      'rimIntensity',
      'fogNear',
      'fogFar',
    ].forEach((key) => {
      if (Number.isFinite(lighting[key])) this.hybridLighting[key] = lighting[key];
    });

    [
      'ambientColor',
      'practicalColor',
      'windowColor',
      'rimColor',
      'fogColor',
      'clearColor',
    ].forEach((key) => {
      if (typeof lighting[key] === 'string' || Number.isFinite(lighting[key])) {
        this.hybridLighting[key] = new THREE.Color(lighting[key]).getHex();
      }
    });

    [
      ['practicalPosition', 'practicalPosition'],
      ['windowPosition', 'windowPosition'],
      ['rimPosition', 'rimPosition'],
    ].forEach(([jsonKey, settingKey]) => {
      if (Array.isArray(lighting[jsonKey])) {
        this.hybridLighting[settingKey] = this.arrayToVector3(lighting[jsonKey], this.hybridLighting[settingKey]);
      }
    });
  },

  applyRoomLightingProfile(roomData = null, scene = null) {
    const lighting = roomData?.hybrid3d?.lighting || {};
    this.applyHybridLightingSettings(lighting);
    const activeScene = scene || this.currentRoom?.scene;
    if (activeScene) {
      activeScene.fog = new THREE.Fog(
        this.hybridLighting.fogColor,
        this.hybridLighting.fogNear,
        this.hybridLighting.fogFar
      );
      activeScene.traverse((object) => {
        if (!object.userData?.hybridRoomLight) return;
        const key = object.userData.hybridRoomLight;
        if (key === 'ambient') {
          object.color.setHex(this.hybridLighting.ambientColor);
          object.intensity = this.hybridLighting.ambientIntensity;
        } else if (key === 'practical') {
          object.color.setHex(this.hybridLighting.practicalColor);
          object.intensity = this.hybridLighting.practicalIntensity;
          object.position.copy(this.hybridLighting.practicalPosition);
        } else if (key === 'window') {
          object.color.setHex(this.hybridLighting.windowColor);
          object.intensity = this.hybridLighting.windowIntensity;
          object.position.copy(this.hybridLighting.windowPosition);
        } else if (key === 'rim') {
          object.color.setHex(this.hybridLighting.rimColor);
          object.intensity = this.hybridLighting.rimIntensity;
          object.position.copy(this.hybridLighting.rimPosition);
        }
      });
    }
    if (this.renderer) {
      this.renderer.setClearColor(this.hybridLighting.clearColor, 1);
    }
  },

  createPlaceholderRoom() {
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x040408, 4, 13);

    const cameraConfig = this.hybridRoomData?.hybrid3d?.threeCamera;
    const cameraPosition = this.arrayToVector3(cameraConfig?.position, new THREE.Vector3(0, 1.75, 5.2));
    const cameraTarget = this.arrayToVector3(cameraConfig?.target, new THREE.Vector3(0, 1.15, -1.25));
    const camera = this.createHybridCamera(cameraConfig, cameraPosition, cameraTarget);
    this.configureWalkPlaneForCamera(camera);
    this.calibrateHybridActorHeight(camera);

    scene.add(camera);
    this.addPrerenderedRoomLayers(camera);
    this.addInvisibleWalkFloor(scene);

    const boxTexture = new THREE.CanvasTexture(this.generatePixelTexture('#7b4a40'));
    boxTexture.magFilter = THREE.NearestFilter;
    boxTexture.minFilter = THREE.NearestFilter;

    const crateSize = 0.68 * this.hybridComposition.propScale;
    const box = new THREE.Mesh(new THREE.BoxGeometry(crateSize, crateSize, crateSize), new THREE.MeshStandardMaterial({ map: boxTexture, roughness: 0.95 }));
    box.position.set(-1.95, crateSize / 2, -0.45);
    box.userData = { interactionId: 'inspectBox' };
    scene.add(box);
    this.addBlobShadow(scene, box.position, 0.42 * this.hybridComposition.propScale);

    // Load main character FBX.
    const loader = this.createModelLoader('MC');
    loader.load('./Models/MC.fbx', (fbx) => {
      const character = this.createCharacterController(fbx);
      this.prepareModelMaterials(fbx);
      this.placeCharacterAtRoomStart(character);
      character.visible = false;
      scene.add(character);
      this.character = character;
      this.characterModel = fbx;
      this.setupHeadLook(fbx);
      this.setupWeaponAttachment(fbx);
      this.setupCharacterAnimations(fbx, character);
    }, undefined, (error) => {
      console.error('Failed to load Models/MC.fbx', error);
      this.character = this.createFallbackCharacter();
      this.placeCharacterAtRoomStart(this.character);
      scene.add(this.character);
    });
    this.getRoomActorConfigs().forEach((config) => {
      this.loadSceneModel(scene, config);
    });
    this.getRoomPropConfigs().forEach((config) => {
      this.loadPlacedModel(scene, config);
    });

    const door = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.9, 0.12), new THREE.MeshBasicMaterial({
      color: 0x080808,
      transparent: true,
      opacity: 0.08,
    }));
    door.position.set(2.55, 0.95, -3.8);
    door.userData = { interactionId: 'openDoor' };
    scene.add(door);

    this.addHybridActorLighting(scene);

    return {
      id: 'placeholderRoom',
      name: this.hybridRoomData?.displayName || 'Apartment 708 / Entry',
      roomData: this.hybridRoomData,
      scene,
      camera,
      fixedCamera: {
        position: cameraPosition,
        target: cameraTarget,
      },
    };
  },

  arrayToVector3(value, fallback) {
    if (!Array.isArray(value) || value.length < 3) return fallback;
    return new THREE.Vector3(value[0], value[1], value[2]);
  },

  arrayToVector2(value, fallback) {
    if (!Array.isArray(value) || value.length < 2) return fallback;
    return new THREE.Vector2(value[0], value[1]);
  },

  arrayToEuler(value, fallback) {
    if (!Array.isArray(value) || value.length < 3) return fallback;
    return new THREE.Euler(value[0], value[1], value[2]);
  },

  getAssetPath(path) {
    if (!path || typeof path !== 'string') return null;
    if (/^(blob:|https?:)?\/\//i.test(path) || path.startsWith('blob:') || path.startsWith('./') || path.startsWith('../')) return path;
    return `./${path}`;
  },

  getGlobalAssetPath(path) {
    if (!path || typeof path !== 'string') return null;
    if (/^(blob:|https?:)?\/\//i.test(path) || path.startsWith('blob:')) return path;
    const normalized = this.normalizeAssetKey(path);
    const bare = normalized.replace(/^(?:\.\.\/)+/, '');
    const candidates = [
      normalized,
      bare,
      normalized.replace(/^\.\//, ''),
      bare.replace(/^\.\//, ''),
    ];
    for (const packageInfo of Object.values(this.assetPackages)) {
      for (const candidate of candidates) {
        if (packageInfo.assetUrls[candidate]) return packageInfo.assetUrls[candidate];
      }
    }
    return this.getAssetPath(path);
  },

  getRoomActorConfigs() {
    const roomId = this.hybridRoomData?.id || null;
    return (this.hybridRoomData?.actors || [])
      .filter((actor) => !actor.type || actor.type === 'npc' || actor.type === 'zombie')
      .map((actor) => ({ ...this.normalizeActorConfig(actor), roomId }))
      .filter((actor) => actor.path);
  },

  getRoomPropConfigs() {
    const roomId = this.hybridRoomData?.id || null;
    return (this.hybridRoomData?.props || this.hybridRoomData?.models || [])
      .map((prop) => ({ ...this.normalizeActorConfig(prop), roomId }))
      .filter((prop) => prop.path);
  },

  normalizeActorConfig(actor) {
    const movement = actor.movement ? {
      ...actor.movement,
      path: (actor.movement.path || []).map((point) => this.arrayToVector3(point, new THREE.Vector3())),
    } : {};
    return {
      ...actor,
      path: this.getRoomAssetPath(this.hybridRoomData, actor.path),
      position: this.arrayToVector3(actor.position, new THREE.Vector3()),
      rotationY: actor.rotationY ?? 0,
      movement,
    };
  },

  createHybridCamera(cameraConfig = {}, position, target) {
    const aspect = window.innerWidth / window.innerHeight;
    let camera;
    if (cameraConfig.projection === 'orthographic') {
      const layerSize = this.getHybridLayerSize();
      const orthoHeight = cameraConfig.orthoHeight || layerSize.y;
      const orthoWidth = orthoHeight * aspect;
      camera = new THREE.OrthographicCamera(
        -orthoWidth / 2,
        orthoWidth / 2,
        orthoHeight / 2,
        -orthoHeight / 2,
        0.1,
        50
      );
      camera.userData.orthoHeight = orthoHeight;
    } else {
      camera = new THREE.PerspectiveCamera(cameraConfig.fov || 55, aspect, 0.1, 50);
    }
    camera.position.copy(position);
    camera.lookAt(target);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    return camera;
  },

  addPrerenderedRoomLayers(camera) {
    const loader = new THREE.TextureLoader();
    const addLayer = ({
      src,
      z,
      renderOrder,
      transparent = false,
      depthTest = true,
      opacity = 1,
      exposure = 1,
      tint = '#ffffff',
      tintStrength = 0,
    }) => {
      const texture = loader.load(src, (loadedTexture) => {
        loadedTexture.colorSpace = THREE.SRGBColorSpace;
        loadedTexture.magFilter = THREE.NearestFilter;
        loadedTexture.minFilter = THREE.LinearMipMapLinearFilter;
      });
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.magFilter = THREE.NearestFilter;
      const material = this.createRoomPlateMaterial({
        texture,
        exposure,
        opacity,
        tint,
        tintStrength,
        transparent,
        depthTest,
      });
      const layerSize = this.getHybridLayerSize();
      const layer = new THREE.Mesh(new THREE.PlaneGeometry(layerSize.x, layerSize.y), material);
      layer.position.set(0, 0, z);
      layer.renderOrder = renderOrder;
      camera.add(layer);
      return layer;
    };

    addLayer({
      src: this.hybridRoomLayerPaths.background,
      z: -12,
      renderOrder: -100,
      exposure: this.hybridComposition.backgroundExposure,
      tint: this.hybridComposition.backgroundTint,
      tintStrength: this.hybridComposition.backgroundTintStrength,
    });
    addLayer({
      src: this.hybridRoomLayerPaths.foreground,
      z: -11.9,
      renderOrder: 100,
      transparent: true,
      opacity: this.hybridComposition.foregroundOpacity,
      depthTest: false,
    });
  },

  createRoomPlateMaterial({ texture, exposure = 1, opacity = 1, tint = '#ffffff', tintStrength = 0, transparent = false, depthTest = true }) {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: texture },
        exposure: { value: exposure },
        opacity: { value: opacity },
        tint: { value: new THREE.Color(tint) },
        tintStrength: { value: tintStrength },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D map;
        uniform float exposure;
        uniform float opacity;
        uniform vec3 tint;
        uniform float tintStrength;
        varying vec2 vUv;
        void main() {
          vec4 texel = texture2D(map, vUv);
          vec3 lifted = texel.rgb * exposure;
          lifted = lifted / (lifted + vec3(0.35));
          lifted = pow(lifted, vec3(0.82));
          lifted = mix(lifted, lifted * tint, clamp(tintStrength, 0.0, 1.0));
          gl_FragColor = vec4(lifted, texel.a * opacity);
        }
      `,
      transparent: transparent || opacity < 1,
      depthWrite: false,
      depthTest,
      side: THREE.DoubleSide,
    });
    material.toneMapped = false;
    return material;
  },

  getHybridLayerSize() {
    return this.hybridComposition.baseLayerSize.clone().multiplyScalar(this.hybridComposition.roomZoom);
  },

  getHybridActorHeight(scale = 1) {
    if (Number.isFinite(this.hybridComposition.calibratedActorHeight)) {
      return this.hybridComposition.calibratedActorHeight * scale;
    }
    const { doorWorldHeight, actorDoorRatio, npcScale } = this.hybridComposition;
    return doorWorldHeight * actorDoorRatio * npcScale * scale;
  },

  calibrateHybridActorHeight(camera) {
    const reference = this.hybridRoomData?.hybrid3d?.screenScaleReference;
    if (!reference?.doorRect) return;

    const referencePosition = this.arrayToVector3(
      reference.actorReferencePosition,
      new THREE.Vector3(0, 0, -1.5)
    );
    const fraction = Number.isFinite(reference.targetActorFractionOfDoor)
      ? reference.targetActorFractionOfDoor
      : this.hybridComposition.actorDoorRatio;
    const referenceCanvasHeight = this.hybridRoomData?.camera?.height || 1080;
    const canvasRect = this.renderer.domElement.getBoundingClientRect();
    const cssHeight = canvasRect.height || window.innerHeight || referenceCanvasHeight;
    const doorPixelHeight = reference.doorRect[3] * (cssHeight / referenceCanvasHeight);
    const targetPixelHeight = doorPixelHeight * fraction;
    const unitPixelHeight = this.getProjectedPixelHeight(camera, referencePosition, 1);

    if (unitPixelHeight > 0) {
      this.hybridComposition.calibratedActorHeight = targetPixelHeight / unitPixelHeight;
    }
  },

  getProjectedPixelHeight(camera, position, worldHeight) {
    const canvasRect = this.renderer.domElement.getBoundingClientRect();
    const cssHeight = canvasRect.height || window.innerHeight || 1;
    const bottom = position.clone();
    const top = position.clone();
    top.y += worldHeight;
    bottom.project(camera);
    top.project(camera);
    return Math.abs((top.y - bottom.y) * 0.5 * cssHeight);
  },

  configureWalkPlaneForCamera(camera) {
    const config = this.walkPlaneConfig;
    if (!config?.top || !config?.bottom) return;

    const top = this.getPointOnCameraRayAtZ(
      { x: config.top[0], y: config.top[1] },
      config.top[2],
      camera
    );
    const bottom = this.getPointOnCameraRayAtZ(
      { x: config.bottom[0], y: config.bottom[1] },
      config.bottom[2],
      camera
    );
    if (!top || !bottom || Math.abs(bottom.z - top.z) < 0.001) return;

    const slopeZ = (bottom.y - top.y) / (bottom.z - top.z);
    const offsetY = top.y - slopeZ * top.z;
    this.setTiltedWalkSurface(slopeZ, offsetY);
  },

  getPointOnCameraRayAtZ(point, z, camera = this.currentRoom?.camera || this.rooms.placeholderRoom?.camera) {
    if (!camera || !point || !Number.isFinite(z)) return null;

    const rect = this.renderer.domElement.getBoundingClientRect();
    const width = this.hybridRoomData?.camera?.width || 1920;
    const height = this.hybridRoomData?.camera?.height || 1080;
    const plateRect = this.getRoomPlateScreenRect(rect);
    const screenX = plateRect.left + (point.x / width) * plateRect.width;
    const screenY = plateRect.top + (point.y / height) * plateRect.height;

    this.pointer.x = ((screenX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((screenY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, camera);

    const directionZ = this.raycaster.ray.direction.z;
    if (Math.abs(directionZ) < 0.00001) return null;
    const distance = (z - this.raycaster.ray.origin.z) / directionZ;
    return this.raycaster.ray.at(distance, new THREE.Vector3());
  },

  addInvisibleWalkFloor(scene) {
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(9.2, 8.2),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0;
    floor.name = 'invisible-walk-floor';
    scene.add(floor);
  },

  addBlobShadow(scene, position, radius = 0.5) {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
    gradient.addColorStop(0, 'rgba(0,0,0,0.36)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);

    const texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = THREE.NearestFilter;
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(radius * 2, radius),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(position.x, 0.012, position.z + 0.04);
    shadow.renderOrder = -10;
    scene.add(shadow);
  },

  addHybridActorLighting(scene) {
    const lighting = this.hybridLighting;

    const ambient = new THREE.AmbientLight(lighting.ambientColor, lighting.ambientIntensity);
    ambient.userData.hybridRoomLight = 'ambient';
    scene.add(ambient);

    const practical = new THREE.PointLight(lighting.practicalColor, lighting.practicalIntensity, 8.5, 1.8);
    practical.position.copy(lighting.practicalPosition);
    practical.userData.hybridRoomLight = 'practical';
    scene.add(practical);

    const windowFill = new THREE.DirectionalLight(lighting.windowColor, lighting.windowIntensity);
    windowFill.position.copy(lighting.windowPosition);
    windowFill.target.position.set(0.4, 0.9, 0.2);
    windowFill.userData.hybridRoomLight = 'window';
    scene.add(windowFill);
    scene.add(windowFill.target);

    const rim = new THREE.DirectionalLight(lighting.rimColor, lighting.rimIntensity);
    rim.position.copy(lighting.rimPosition);
    rim.target.position.set(0.4, 0.8, 0.7);
    rim.userData.hybridRoomLight = 'rim';
    scene.add(rim);
    scene.add(rim.target);
  },

  createHallwayRoom() {
    const roomData = this.hallwayRoomData;
    if (roomData?.hybrid3d) {
      return this.createPrerenderedRoom(roomData);
    }

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x040408, 1, 12);

    const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 50);
    camera.position.set(0, 1.7, 4);
    camera.lookAt(0, 1.5, 0);

    const floorMat = new THREE.MeshStandardMaterial({ color: 0x1d1b21, roughness: 1 });
    const floor = new THREE.Mesh(new THREE.BoxGeometry(8, 0.2, 6), floorMat);
    floor.position.y = -0.1;
    scene.add(floor);

    const wallMat = new THREE.MeshStandardMaterial({ color: 0x2c2327, roughness: 1 });
    const leftWall = new THREE.Mesh(new THREE.BoxGeometry(0.25, 3, 6), wallMat);
    leftWall.position.set(-4, 1.5, 0);
    scene.add(leftWall);

    const rightWall = leftWall.clone();
    rightWall.position.set(4, 1.5, 0);
    scene.add(rightWall);

    const backWall = new THREE.Mesh(new THREE.BoxGeometry(8, 3, 0.25), wallMat);
    backWall.position.set(0, 1.5, -3);
    scene.add(backWall);

    const light = new THREE.PointLight(0xffebcd, 1.5, 12);
    light.position.set(0, 2.8, 3);
    scene.add(light);

    const ambient = new THREE.HemisphereLight(0xd7dde8, 0x21161a, 0.9);
    scene.add(ambient);

    return {
      id: 'hallway_7f',
      name: 'Seventh Floor Hallway',
      scene,
      camera,
      fixedCamera: {
        position: new THREE.Vector3(0, 1.7, 4),
        target: new THREE.Vector3(0, 1.5, 0),
      },
    };
  },

  createPrerenderedRoom(roomData) {
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x040408, 4, 13);

    const layerSize = this.arrayToVector2(
      roomData?.hybrid3d?.composition?.baseLayerSize,
      new THREE.Vector2(18.4, 10.35)
    );
    const cameraConfig = roomData?.hybrid3d?.threeCamera || {};
    const cameraPosition = this.arrayToVector3(cameraConfig.position, new THREE.Vector3(0, 1.75, 5.2));
    const cameraTarget = this.arrayToVector3(cameraConfig.target, new THREE.Vector3(0, 1.15, -1.25));
    const aspect = window.innerWidth / window.innerHeight;
    const orthoHeight = cameraConfig.orthoHeight || layerSize.y;
    const camera = new THREE.OrthographicCamera(
      -(orthoHeight * aspect) / 2,
      (orthoHeight * aspect) / 2,
      orthoHeight / 2,
      -orthoHeight / 2,
      0.1,
      50
    );
    camera.userData.orthoHeight = orthoHeight;
    camera.userData.layerSize = layerSize.clone();
    camera.position.copy(cameraPosition);
    camera.lookAt(cameraTarget);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    scene.add(camera);

    this.addRoomLayersToCamera(camera, roomData, layerSize);
    this.addHybridActorLighting(scene);
    this.getRoomActorConfigs().forEach((config) => {
      this.loadSceneModel(scene, config);
    });
    this.getRoomPropConfigs().forEach((config) => {
      this.loadPlacedModel(scene, config);
    });

    return {
      id: roomData.id,
      name: roomData.displayName || roomData.id,
      roomData,
      layerSize,
      scene,
      camera,
      fixedCamera: {
        position: cameraPosition,
        target: cameraTarget,
      },
    };
  },

  addRoomLayersToCamera(camera, roomData, layerSize) {
    const loader = new THREE.TextureLoader();
    const addLayer = ({
      src,
      z,
      renderOrder,
      transparent = false,
      depthTest = true,
      opacity = 1,
      exposure = 1,
      tint = '#ffffff',
      tintStrength = 0,
    }) => {
      if (!src) return null;
      const texture = loader.load(this.getRoomAssetPath(roomData, src), (loadedTexture) => {
        loadedTexture.colorSpace = THREE.SRGBColorSpace;
        loadedTexture.magFilter = THREE.NearestFilter;
        loadedTexture.minFilter = THREE.LinearMipMapLinearFilter;
      });
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.magFilter = THREE.NearestFilter;
      const material = this.createRoomPlateMaterial({
        texture,
        exposure,
        opacity,
        tint,
        tintStrength,
        transparent,
        depthTest,
      });
      const layer = new THREE.Mesh(new THREE.PlaneGeometry(layerSize.x, layerSize.y), material);
      layer.position.set(0, 0, z);
      layer.renderOrder = renderOrder;
      camera.add(layer);
      return layer;
    };

    const composition = roomData?.hybrid3d?.composition || {};
    addLayer({
      src: roomData?.hybrid3d?.layers?.background || roomData?.layers?.background,
      z: -12,
      renderOrder: -100,
      exposure: composition.backgroundExposure ?? 1,
      tint: composition.backgroundTint || '#ffffff',
      tintStrength: composition.backgroundTintStrength ?? 0,
    });
    addLayer({
      src: roomData?.hybrid3d?.layers?.foreground || roomData?.layers?.foreground,
      z: -11.9,
      renderOrder: 100,
      transparent: true,
      opacity: composition.foregroundOpacity ?? 1,
      depthTest: false,
    });
  },

  generatePixelTexture(color) {
    const size = 16;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 20; i++) {
      ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.2})`;
      ctx.fillRect(Math.floor(Math.random() * size), Math.floor(Math.random() * size), 1, 1);
    }
    return canvas;
  },

  createModelLoader(textureFolder) {
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
      const normalizedUrl = url.replaceAll('\\', '/');
      const textureName = normalizedUrl.split('/').pop();
      const folderMatch = normalizedUrl.match(/Models\/([^/]+)\.fbm\//i);
      if (folderMatch && textureName) {
        return this.getGlobalAssetPath(`Models/${folderMatch[1]}.fbm/${textureName}`);
      }
      if (textureName && /\.(jpe?g|png|tga|webp)$/i.test(textureName)) {
        return this.getGlobalAssetPath(`Models/${textureFolder}.fbm/${textureName}`);
      }
      return this.getGlobalAssetPath(normalizedUrl);
    });
    return new FBXLoader(manager);
  },

  prepareModelMaterials(model) {
    model.traverse((child) => {
      if (!child.isMesh) return;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((material) => {
        if (!material) return;
        if (material.map) {
          material.map.magFilter = THREE.NearestFilter;
          material.map.minFilter = THREE.NearestFilter;
          material.map.colorSpace = THREE.SRGBColorSpace;
        }
        if (material.normalMap) {
          material.normalMap.magFilter = THREE.NearestFilter;
          material.normalMap.minFilter = THREE.NearestFilter;
        }
        material.roughness = Math.max(material.roughness ?? 0.9, 0.88);
        material.metalness = Math.min(material.metalness ?? 0, 0.04);
        material.needsUpdate = true;
      });
      child.castShadow = true;
    });
  },

  setupCharacterAnimations(model, character = this.character) {
    this.characterAnimator = new ActorAnimator(model);
    window.DEBUG_ANIMATION = () => this.characterAnimator.getDebugState();
    this.loadCharacterAnimation('idle')
      .then((idleClip) => {
        if (!idleClip) throw new Error('Missing required character idle animation.');
        console.info(`Loaded animation "${idleClip.name}" (${idleClip.duration.toFixed(2)}s, ${idleClip.tracks.length} tracks).`);
        this.registerCharacterAnimation('idle', idleClip);
        this.playCharacterAnimation('idle', 0);
        this.characterAnimator.update(0);
        if (character) character.visible = true;
        this.loadOptionalCharacterAnimation('walk');
        this.loadOptionalCharacterAnimation('backpedal');
        this.loadOptionalCharacterAnimation('aim');
      })
      .catch((error) => {
        console.warn('Failed to load character animations.', error);
        if (character) character.visible = true;
      });
  },

  loadOptionalCharacterAnimation(name) {
    this.loadCharacterAnimation(name).then((clip) => {
      if (!clip) return;
      console.info(`Loaded animation "${clip.name}" (${clip.duration.toFixed(2)}s, ${clip.tracks.length} tracks).`);
      this.registerCharacterAnimation(name, clip);
    });
  },

  getCharacterAnimationPath(name) {
    if (!name) return null;
    const roomAnimations = this.hybridRoomData?.playerAnimations || {};
    if (Object.prototype.hasOwnProperty.call(roomAnimations, name)) {
      return roomAnimations[name] ? `./${roomAnimations[name]}` : null;
    }
    return this.characterAnimationPaths[name] || `./Animation/${name}.fbx`;
  },

  loadCharacterAnimation(name) {
    if (!name) return Promise.resolve(null);
    if (this.animationLibrary.get(name)) return Promise.resolve(this.animationLibrary.get(name));
    if (this.characterAnimationPromises[name]) return this.characterAnimationPromises[name];

    const path = this.getCharacterAnimationPath(name);
    if (!path) return Promise.resolve(null);
    this.characterAnimationPromises[name] = this.animationLibrary.load(name, path)
      .catch((error) => {
        console.warn(`Failed to load character animation "${name}".`, error);
        return null;
      });
    return this.characterAnimationPromises[name];
  },

  registerCharacterAnimation(name, clip) {
    if (!name || !clip || !this.characterAnimator || this.hasCharacterAction(name)) return;
    this.characterAnimator.addClip(name, clip);
  },

  hasCharacterAction(name) {
    if (!this.characterAnimator || !name) return false;
    if (typeof this.characterAnimator.hasAction === 'function') {
      return this.characterAnimator.hasAction(name);
    }
    return this.characterAnimator.actions?.has?.(name) || false;
  },

  ensureNPCAnimationsLoaded() {
    if (this.npcAnimationPromise) return this.npcAnimationPromise;
    const animationPaths = this.hybridRoomData?.npcAnimations || {};
    this.npcAnimationPromise = Promise.all(
      Object.entries(animationPaths)
        .filter(([, path]) => path)
        .map(([name, path]) => this.npcAnimationLibrary.load(name, this.getAssetPath(path)))
    ).catch((error) => {
      console.warn('Failed to load NPC animations.', error);
    });
    return this.npcAnimationPromise;
  },

  setupHeadLook(model) {
    this.characterHeadBone = null;
    model.traverse((child) => {
      if (this.characterHeadBone) return;
      if (/CC_Base_Head|Head/i.test(child.name)) {
        this.characterHeadBone = child;
      }
    });
    this.characterHeadBaseRotation = this.characterHeadBone?.rotation.clone() || null;
  },

  setupWeaponAttachment(model) {
    this.characterRightHandBone = this.findRightHandBone(model);
    window.DEBUG_HAND_BONES = () => this.listCharacterBones(/hand|wrist|index|thumb/i);
    window.DEBUG_WEAPON = () => this.getWeaponDebugState();
    window.SET_WEAPON_OFFSET = (position = this.weaponConfig.position, rotation = this.weaponConfig.rotation, scale = this.weaponConfig.scale) => {
      this.weaponConfig.position = position;
      this.weaponConfig.rotation = rotation;
      this.weaponConfig.scale = scale;
      this.applyWeaponTransform();
      return this.getWeaponDebugState();
    };
    this.loadAndAttachWeapon();
  },

  findRightHandBone(model) {
    const candidates = [];
    model.traverse((child) => {
      if (!child.isBone) return;
      candidates.push(child);
    });
    return candidates.find((bone) => /RightHand|Right_Hand|hand[_\-. ]?r|r[_\-. ]?hand|mixamorig.*RightHand|CC_Base_R_Hand/i.test(bone.name))
      || candidates.find((bone) => /right.*hand|hand.*right/i.test(bone.name))
      || null;
  },

  listCharacterBones(pattern = null) {
    const bones = [];
    this.characterModel?.traverse((child) => {
      if (child.isBone && (!pattern || pattern.test(child.name))) bones.push(child.name);
    });
    return bones;
  },

  loadAndAttachWeapon() {
    if (!this.characterRightHandBone) {
      console.warn('Right hand bone not found; Glock not attached.', this.listCharacterBones(/hand|wrist/i));
      return;
    }
    if (this.weaponRoot) {
      this.characterRightHandBone.add(this.weaponRoot);
      return;
    }
    const loader = this.createModelLoader(this.weaponConfig.textureFolder);
    loader.load(this.getGlobalAssetPath(this.weaponConfig.path), (fbx) => {
      this.prepareModelMaterials(fbx);
      this.weaponModel = fbx;
      this.weaponRoot = new THREE.Group();
      this.weaponRoot.name = 'romeo_glock_attachment';
      this.weaponRoot.add(fbx);
      this.weaponMuzzle = new THREE.Object3D();
      this.weaponMuzzle.name = 'romeo_glock_muzzle';
      this.weaponRoot.add(this.weaponMuzzle);
      this.applyWeaponTransform();
      this.characterRightHandBone.add(this.weaponRoot);
    }, undefined, (error) => {
      console.warn(`Failed to load ${this.weaponConfig.path}`, error);
    });
  },

  applyWeaponTransform() {
    if (!this.weaponRoot) return;
    this.weaponRoot.position.copy(this.arrayToVector3(this.weaponConfig.position, new THREE.Vector3()));
    this.weaponRoot.rotation.copy(this.arrayToEuler(this.weaponConfig.rotation, new THREE.Euler()));
    const scale = Number.isFinite(this.weaponConfig.scale) ? this.weaponConfig.scale : 1;
    this.weaponRoot.scale.setScalar(scale);
    if (this.weaponMuzzle) {
      this.weaponMuzzle.position.copy(this.arrayToVector3(this.weaponConfig.muzzlePosition, new THREE.Vector3(0, 0, 0.34)));
    }
  },

  getWeaponMuzzleWorldPosition() {
    if (!this.weaponMuzzle) return null;
    this.weaponMuzzle.updateWorldMatrix(true, false);
    return this.weaponMuzzle.getWorldPosition(new THREE.Vector3());
  },

  getWeaponDebugState() {
    const muzzle = this.getWeaponMuzzleWorldPosition();
    return {
      hasRightHandBone: Boolean(this.characterRightHandBone),
      rightHandBone: this.characterRightHandBone?.name || null,
      hasWeapon: Boolean(this.weaponRoot),
      config: this.weaponConfig,
      muzzleWorld: muzzle ? { x: muzzle.x, y: muzzle.y, z: muzzle.z } : null,
    };
  },

  setHeadLookFromPointer(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const y = ((event.clientY - rect.top) / rect.height) * 2 - 1;
    const look = this.normalizeHeadLookVector(x, y + this.headLook.verticalBias);
    this.headLook.x = look.x;
    this.headLook.y = look.y;
  },

  normalizeHeadLookVector(x, y) {
    const length = Math.hypot(x, y);
    if (length === 0) return { x: 0, y: 0 };

    const clampedLength = Math.min(length, 1);
    const directionX = x / length;
    const directionY = y / length;
    const magnitude = clampedLength;
    if (magnitude <= this.headLook.deadZone) return { x: 0, y: 0 };
    const normalized = (magnitude - this.headLook.deadZone) / (1 - this.headLook.deadZone);
    const curvedMagnitude = normalized * normalized;
    return {
      x: directionX * curvedMagnitude,
      y: directionY * curvedMagnitude,
    };
  },

  clearHeadLookOffset() {
    if (!this.characterHeadBone) return;
    this.characterHeadBone.rotation[this.headLook.pitchAxis] -= this.headLook.pitchOffset;
    this.characterHeadBone.rotation[this.headLook.yawAxis] -= this.headLook.yawOffset;
  },

  playCharacterAnimation(name, fadeSeconds = 0.18) {
    if (!this.characterAnimator || this.characterAnimationState === name) return;
    if (!this.hasCharacterAction(name)) {
      this.loadCharacterAnimation(name).then((clip) => {
        if (!clip || !this.characterAnimator) return;
        this.registerCharacterAnimation(name, clip);
      });
      return;
    }
    this.characterAnimationState = name;
    this.characterAnimator.play(name, fadeSeconds, this.characterAnimationSpeeds[name] || 1);
  },

  playIdleAnimation(fadeSeconds = 0.18) {
    this.playCharacterAnimation('idle', fadeSeconds);
  },

  playWalkAnimation(fadeSeconds = 0.18) {
    this.playCharacterAnimation('walk', fadeSeconds);
  },

  playBackpedalAnimation(fadeSeconds = 0.18) {
    this.playCharacterAnimation('backpedal', fadeSeconds);
  },

  playCarryIdleAnimation(fadeSeconds = 0.18) {
    if (this.hasCharacterAction('carry_idle')) {
      this.playCharacterAnimation('carry_idle', fadeSeconds);
      return;
    }
    this.playIdleAnimation(fadeSeconds);
  },

  playCarryWalkAnimation(fadeSeconds = 0.18) {
    if (this.hasCharacterAction('carry_walk')) {
      this.playCharacterAnimation('carry_walk', fadeSeconds);
      return;
    }
    this.playWalkAnimation(fadeSeconds);
  },

  playAimAnimation(fadeSeconds = 0.12) {
    if (!this.characterAnimator || this.characterAnimationState === 'aim') return;
    if (!this.hasCharacterAction('aim')) return;
    this.characterAnimationState = 'aim';
    this.characterAnimator.playUntilHold('aim', this.characterAimPoseTime, fadeSeconds, 1.25);
  },

  playInteractionAnimation(name) {
    if (name === null || name === undefined || name === '') {
      this.characterInteractionAnimationUntil = 0;
      this.playIdleAnimation();
      return;
    }

    this.loadCharacterAnimation(name).then((clip) => {
      if (!clip || !this.characterAnimator) {
        this.playIdleAnimation();
        return;
      }
      this.registerCharacterAnimation(name, clip);
      if (!this.hasCharacterAction(name)) {
        this.playIdleAnimation();
        return;
      }

      this.characterAnimationState = name;
      this.characterAnimator.playOnce(name, 0.12, this.characterAnimationSpeeds[name] || 1);
      const duration = this.characterAnimator.getClipDuration(name);
      this.characterInteractionAnimationUntil = performance.now() + Math.max(duration * 1000, 450);
    });
  },

  isPlayerBusy() {
    return this.cinematicActive || this.characterInteractionAnimationUntil > performance.now() || NarratorVoice.isBusy();
  },

  update(delta, movementState = 'idle') {
    if (this.cinematicActive && this.character) {
      this.character.visible = false;
    }
    this.applyActorDepthScaling();
    const interactionAnimationActive = this.characterInteractionAnimationUntil > performance.now();
    if (interactionAnimationActive) {
      // Let one-shot JSON-driven inspection animations finish before returning to locomotion.
    } else if (movementState === 'aim') {
      this.playAimAnimation();
    } else if (movementState === 'walk') {
      this.playWalkAnimation();
    } else if (movementState === 'backpedal') {
      this.playBackpedalAnimation();
    } else if (movementState === 'carry-walk') {
      this.playCarryWalkAnimation();
    } else if (movementState === 'carry-idle') {
      this.playCarryIdleAnimation();
    } else {
      this.playIdleAnimation();
    }
    this.clearHeadLookOffset();
    this.characterAnimator?.update(delta);
    this.updateHeadLook(delta);
    const characterBlocker = this.character
      ? { position: this.character.position, collisionRadius: this.characterCollisionRadius }
      : null;
    const activeNPCs = this.getActiveNPCs();
    if (this.isPlayerBusy()) {
      activeNPCs.forEach((npc) => {
        npc.play?.('idle');
        npc.animator?.update(delta);
      });
    } else {
      activeNPCs.forEach((npc) => npc.update(delta, {
        blockers: [characterBlocker, ...activeNPCs, ...this.getActivePropBlockers()].filter(Boolean),
        canMoveTo: (position, fromPosition, movingNpc) => this.canNPCMoveToWorldPosition(position, fromPosition, movingNpc),
      }));
    }
    this.resolveActorOverlaps();
    this.applyZombieContactDamage();
    this.updateDriveParallax(delta);
  },

  applyActorDepthScaling() {
    this.applyDepthScaleToActor(this.character, this.characterHeightScale);
    this.getActiveNPCs().forEach((npc) => this.applyDepthScaleToActor(npc.root, 1));
  },

  applyDepthScaleToActor(actor, baseScale = 1) {
    if (!actor) return;
    const scale = this.getActorDepthScale(actor.position, baseScale);
    actor.scale.setScalar(scale);
    actor.position.y = this.getWalkSurfaceYAt(actor.position);
  },

  getActorDepthScale(position, baseScale = 1) {
    const config = this.hybridRoomData?.hybrid3d?.actorDepthScale;
    if (!config || !position) return 1;
    const point = this.getRoomPixelFromWorldPosition(position);
    if (!point) return 1;
    const topY = Number.isFinite(config.topY) ? config.topY : 0;
    const bottomY = Number.isFinite(config.bottomY) ? config.bottomY : (this.hybridRoomData?.camera?.height || 1080);
    const topScale = Number.isFinite(config.topScale) ? config.topScale : 0.65;
    const bottomScale = Number.isFinite(config.bottomScale) ? config.bottomScale : 1.05;
    const curve = Number.isFinite(config.curve) ? config.curve : 1.15;
    const t = THREE.MathUtils.clamp((point.y - topY) / Math.max(1, bottomY - topY), 0, 1);
    return THREE.MathUtils.lerp(topScale, bottomScale, Math.pow(t, curve)) * baseScale;
  },

  applyZombieContactDamage() {
    if (!this.character || this.cinematicActive || GameState.hasFlag('player_down')) return;
    const now = performance.now();
    this.getActiveNPCs()
      .filter((npc) => npc.actorType === 'zombie' && (npc.damage || 0) > 0)
      .forEach((npc) => {
        const npcPosition = npc.root?.position;
        if (!npcPosition) return;
        const distance = Math.hypot(this.character.position.x - npcPosition.x, this.character.position.z - npcPosition.z);
        const attackRadius = npc.attackRadius ?? ((npc.collisionRadius ?? this.npcCollisionRadius) + this.characterCollisionRadius);
        if (distance > attackRadius) return;

        const key = `${npc.roomId || 'global'}:${npc.id}`;
        const nextAllowed = this.damageCooldowns.get(key) || 0;
        if (now < nextAllowed) return;
        this.damageCooldowns.set(key, now + (npc.damageCooldownMs ?? 1500));
        GameState.damagePlayer(npc.damage, { id: npc.id, label: npc.label });
        ThreatManager.alertRoom(GameState.currentRoom, 'danger');
        if (!NarratorVoice.isBusy()) {
          NarratorVoice.setAmbientText(GameState.player.health > 0
            ? `The dead thing catches Romeo. Health ${GameState.player.health}.`
            : 'Romeo goes down under dead hands.');
        }
      });
  },

  getPlacedModel(modelId, roomId = this.hybridRoomData?.id || this.currentRoom?.roomData?.id || null) {
    return this.placedModels.find((object) => object.userData?.modelId === modelId && (!roomId || object.roomId === roomId)) || null;
  },

  wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
  },

  async playDriveSequence(sequence = {}, action = {}) {
    if (this.cinematicActive) return false;
    this.cinematicActive = true;
    window.App?.movement?.clearTarget?.();

    const firstRoom = sequence.firstRoom || 'street';
    const firstSpawn = sequence.firstSpawn || 'from_garage';
    const secondRoom = sequence.secondRoom || action.targetRoom || 'street_to_downtown';
    const secondSpawn = sequence.secondSpawn || action.targetSpawn || 'from_garage';
    const restoreCharacterVisible = this.character?.visible !== false;

    try {
      GameState.setRoom(firstRoom, firstSpawn);
      if (this.character) this.character.visible = false;
      NarratorVoice.setAmbientText(sequence.text || action.text || 'Romeo gets the car into the street.');
      this.render();
      await this.nextFrame();
      await this.playFirstPersonDriveCollapse(sequence);
      this.removeDriveOverlay();
      GameState.setRoom(secondRoom, secondSpawn);
      if (this.character) this.character.visible = false;
      this.render();
      await this.nextFrame();
      const secondRoomId = this.hybridRoomData?.id || this.currentRoom?.roomData?.id || secondRoom;
      await this.waitForPlacedModel(sequence.carModelId || 'escape_car', secondRoomId, sequence.carLoadTimeoutMs ?? 7000);
      if (this.character) this.character.visible = false;
      this.startDriveParallax(sequence);
      await this.wait(sequence.secondHoldMs ?? 2300);
      this.cleanupDriveParallax();
      if (this.character) this.character.visible = restoreCharacterVisible;
      NarratorVoice.setAmbientText(sequence.afterText || 'The car rolls into the next block, alive enough to count.');
    } finally {
      this.cleanupDriveParallax();
      this.removeDriveOverlay();
      this.cinematicActive = false;
    }
    return true;
  },

  async playFirstPersonDriveCollapse(sequence = {}) {
    const canvas = this.renderer?.domElement;
    if (!canvas) return Promise.resolve();
    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.zIndex = '20';
    overlay.style.pointerEvents = 'none';
    overlay.style.overflow = 'hidden';
    overlay.style.background = '#000';
    overlay.style.transformOrigin = sequence.vanishingPoint || '50% 45%';

    const imageSrc = sequence.firstPersonImage || this.getCurrentRoomBackgroundSrc();
    const roadLoop = document.createElement('div');
    roadLoop.style.position = 'absolute';
    roadLoop.style.inset = '-18% -18%';
    roadLoop.style.backgroundImage = `url("${imageSrc}")`;
    roadLoop.style.backgroundSize = 'cover';
    roadLoop.style.backgroundPosition = '50% 50%';
    roadLoop.style.transformOrigin = sequence.vanishingPoint || '50% 45%';
    roadLoop.style.filter = 'contrast(1.08) brightness(0.82)';
    roadLoop.style.transform = 'scale(1)';
    roadLoop.style.willChange = 'transform, opacity';

    const collapseMs = sequence.collapseMs ?? 1250;
    const style = document.createElement('style');
    style.textContent = `
      .romeo-drive-zoom {
        transition: transform ${collapseMs}ms cubic-bezier(.08,.74,.18,1), opacity ${collapseMs}ms ease-in;
        transform: scale(var(--drive-zoom-scale, 2.05)) !important;
        opacity: 0.16 !important;
      }
    `;

    const windshield = document.createElement('div');
    windshield.innerHTML = `
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 0 H100 V100 H0 Z" fill="rgba(0,0,0,0.10)"/>
        <path d="M0 74 C18 68 82 68 100 74 V100 H0 Z" fill="rgba(0,0,0,0.88)"/>
        <path d="M0 0 H13 L24 100 H0 Z" fill="rgba(0,0,0,0.76)"/>
        <path d="M87 0 H100 V100 H76 Z" fill="rgba(0,0,0,0.76)"/>
        <path d="M13 0 H87 L75 73 H25 Z" fill="none" stroke="rgba(220,220,205,0.12)" stroke-width="0.7"/>
      </svg>`;
    windshield.style.position = 'absolute';
    windshield.style.inset = '0';

    overlay.appendChild(style);
    overlay.appendChild(roadLoop);
    overlay.appendChild(windshield);
    document.body.appendChild(overlay);
    this.driveOverlay = overlay;

    await this.nextFrame();
    await this.wait(sequence.firstHoldMs ?? 900);

    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        roadLoop.style.setProperty('--drive-zoom-scale', String(sequence.firstPersonZoomScale ?? 2.05));
        roadLoop.classList.add('romeo-drive-zoom');
      });
      setTimeout(resolve, collapseMs + 80);
    });
  },

  getCurrentRoomBackgroundSrc() {
    const source = this.hybridRoomData?.hybrid3d?.layers?.background || this.hybridRoomData?.layers?.background;
    return this.getRoomAssetPath(this.hybridRoomData, source);
  },

  removeDriveOverlay() {
    if (!this.driveOverlay) return;
    this.driveOverlay.remove();
    this.driveOverlay = null;
  },

  startDriveParallax(sequence = {}) {
    const roomId = this.hybridRoomData?.id || this.currentRoom?.roomData?.id;
    const car = this.getPlacedModel(sequence.carModelId || 'escape_car', roomId);
    if (car) {
      car.visible = true;
      car.position.x = sequence.carHoldX ?? sequence.carStartX ?? -1.35;
      if (Number.isFinite(sequence.carY)) car.position.y = sequence.carY;
      car.position.z = sequence.carZ ?? car.position.z;
    }
    const tiledLayers = this.createDriveParallaxTiles(sequence);
    this.driveParallax = {
      elapsed: 0,
      duration: (sequence.parallaxMs ?? 6200) / 1000,
      car,
      carModelId: sequence.carModelId || 'escape_car',
      roomId,
      carStartX: sequence.carStartX ?? -2.25,
      carHoldX: sequence.carHoldX ?? -1.35,
      carEndX: sequence.carEndX ?? 0.35,
      carBob: sequence.carBob ?? 0.035,
      carBaseY: car?.position.y ?? 0,
      layerWidth: this.currentRoom?.camera?.userData?.layerSize?.x || this.getHybridLayerSize().x,
      scrollWorldUnits: sequence.scrollWorldUnits ?? (this.currentRoom?.camera?.userData?.layerSize?.x || this.getHybridLayerSize().x) * (sequence.sideLoops ?? 3),
      tiledLayers,
    };
  },

  createDriveParallaxTiles(sequence = {}) {
    const camera = this.currentRoom?.camera;
    const layerWidth = camera?.userData?.layerSize?.x || this.getHybridLayerSize().x;
    const loops = Math.max(2, Math.ceil(sequence.sideLoops ?? 3));
    const originalLayers = (camera?.children || [])
      .filter((child) => child.isMesh && child.material?.uniforms?.map);
    const groups = [];

    originalLayers.forEach((child, layerIndex) => {
      const clones = [];
      for (let index = -1; index <= loops + 1; index += 1) {
        const clone = child.clone();
        clone.material = child.material;
        clone.position.x = child.position.x + layerWidth * index;
        clone.userData.driveClone = true;
        clone.renderOrder = child.renderOrder;
        camera.add(clone);
        clones.push({ mesh: clone, baseX: clone.position.x });
      }
      child.visible = false;
      groups.push({
        original: child,
        clones,
        depth: layerIndex === 0 ? 1 : 0.55,
      });
    });

    return groups;
  },

  cleanupDriveParallax() {
    if (!this.driveParallax) return;
    this.driveParallax.tiledLayers?.forEach((group) => {
      group.original.visible = true;
      group.clones.forEach(({ mesh }) => mesh.removeFromParent());
    });
    this.driveParallax = null;
  },

  waitForPlacedModel(modelId, roomId, timeoutMs = 7000) {
    const existing = this.getPlacedModel(modelId, roomId);
    if (existing) return Promise.resolve(existing);
    const key = `${roomId || 'global'}:${modelId}`;
    const pending = this.placedModelPromises.get(key);
    if (!pending) {
      console.warn(`Placed model not queued yet: ${key}`);
      return Promise.resolve(null);
    }
    return Promise.race([
      pending,
      this.wait(timeoutMs).then(() => {
        console.warn(`Timed out waiting for placed model: ${key}`);
        return null;
      }),
    ]);
  },

  updateDriveParallax(delta) {
    if (!this.driveParallax) return;
    const state = this.driveParallax;
    state.elapsed += delta;
    const t = Math.min(1, state.elapsed / Math.max(state.duration, 0.001));
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    if (state.car) {
      const enterT = Math.min(1, t / 0.18);
      const leaveT = Math.max(0, (t - 0.78) / 0.22);
      const holdX = THREE.MathUtils.lerp(state.carStartX, state.carHoldX, enterT);
      state.car.position.x = THREE.MathUtils.lerp(holdX, state.carEndX, leaveT);
      state.car.position.y = state.carBaseY + Math.sin(state.elapsed * 18) * state.carBob;
    }
    state.tiledLayers?.forEach((group) => {
      const scroll = state.scrollWorldUnits * eased * group.depth;
      group.clones.forEach(({ mesh, baseX }) => {
        mesh.position.x = baseX - scroll;
      });
    });
  },

  getActiveNPCs() {
    const roomId = this.hybridRoomData?.id || this.currentRoom?.roomData?.id || null;
    return this.npcs.filter((npc) => (!npc.roomId || npc.roomId === roomId) && npc.active !== false && npc.root?.visible !== false);
  },

  updateHeadLook(delta) {
    if (!this.characterHeadBone) return;

    const targetYaw = this.headLook.x * this.headLook.maxYaw * this.headLook.blend * this.headLook.yawSign;
    const targetPitch = this.headLook.neutralPitch + (this.headLook.y * this.headLook.maxPitch * this.headLook.blend * this.headLook.pitchSign);
    const smoothing = 1 - Math.exp(-this.headLook.smoothing * delta);
    this.headLook.yawOffset = THREE.MathUtils.lerp(this.headLook.yawOffset, targetYaw, smoothing);
    this.headLook.pitchOffset = THREE.MathUtils.lerp(this.headLook.pitchOffset, targetPitch, smoothing);

    this.characterHeadBone.rotation[this.headLook.pitchAxis] += this.headLook.pitchOffset;
    this.characterHeadBone.rotation[this.headLook.yawAxis] += this.headLook.yawOffset;
  },

  loadSceneModel(scene, config) {
    const textureFolder = config.textureFolder || config.id;
    const loader = this.createModelLoader(textureFolder);
    loader.load(config.path, (fbx) => {
      this.prepareModelMaterials(fbx);
      const npc = new NPC({
        id: config.id,
        model: fbx,
        position: config.position,
        rotationY: config.rotationY,
        height: config.height ?? this.getHybridActorHeight(config.heightScale ?? 1),
        collisionRadius: config.collisionRadius ?? this.npcCollisionRadius,
        visualRotation: this.characterVisualRotation,
        visualMirrorY: this.characterVisualMirrorY,
        animationLibrary: this.npcAnimationLibrary,
        animations: config.animations,
        movement: config.movement,
      });
      npc.roomId = config.roomId || this.hybridRoomData?.id || this.currentRoom?.roomData?.id || null;
      npc.actorType = config.type || 'npc';
      const pendingKey = `${npc.roomId || 'global'}:${config.id}`;
      const pendingActive = Object.prototype.hasOwnProperty.call(this.pendingActorStates, pendingKey)
        ? this.pendingActorStates[pendingKey]
        : null;
      npc.active = pendingActive ?? (config.active !== false);
      npc.maxHealth = Number.isFinite(config.maxHealth)
        ? config.maxHealth
        : (Number.isFinite(config.health) ? config.health : (config.type === 'zombie' ? 4 : 1));
      npc.health = Number.isFinite(config.health)
        ? config.health
        : npc.maxHealth;
      npc.damage = Number.isFinite(config.damage)
        ? config.damage
        : (config.type === 'zombie' ? 8 : 0);
      npc.damageCooldownMs = Number.isFinite(config.damageCooldownMs) ? config.damageCooldownMs : 1500;
      npc.attackRadius = Number.isFinite(config.attackRadius)
        ? config.attackRadius
        : (npc.collisionRadius ?? this.npcCollisionRadius) + this.characterCollisionRadius + 0.08;
      npc.root.visible = npc.active;
      if (config.interaction) {
        npc.root.userData = {
          ...npc.root.userData,
          interactionId: config.interaction.id,
          characterId: config.id,
          displayName: config.interaction.name || config.id,
          dialog: config.interaction.dialog,
        };
      }
      this.npcs.push(npc);
      scene.add(npc.root);

      this.ensureNPCAnimationsLoaded().then(() => {
        npc.addAnimations();
        npc.currentState = null;
        npc.play('idle', 0);
      });
    }, undefined, () => {
      console.warn(`Optional scene model missing: ${config.path}`);
    });
  },

  loadPlacedModel(scene, config) {
    const textureFolder = config.textureFolder || config.id;
    const loader = this.createModelLoader(textureFolder);
    const modelPath = this.getGlobalAssetPath(config.path);
    const roomId = config.roomId || this.hybridRoomData?.id || this.currentRoom?.roomData?.id || null;
    const promiseKey = `${roomId || 'global'}:${config.id}`;
    const promise = new Promise((resolve) => {
      loader.load(modelPath, (fbx) => {
      this.prepareModelMaterials(fbx);
      const object = this.createPlacedModel(fbx, config);
      object.roomId = roomId;
      object.visible = config.active !== false;
      this.placedModels.push(object);
      if (this.driveParallax
        && !this.driveParallax.car
        && this.driveParallax.carModelId === config.id
        && (!this.driveParallax.roomId || this.driveParallax.roomId === object.roomId)) {
        this.driveParallax.car = object;
        object.visible = true;
        object.position.x = this.driveParallax.carStartX;
        object.position.y = this.driveParallax.carBaseY;
      }
      scene.add(object);
      resolve(object);
      }, undefined, () => {
        console.warn(`Optional placed model missing: ${config.path}`);
        resolve(null);
      });
    });
    this.placedModelPromises.set(promiseKey, promise);
    return promise;
  },

  setActorActive(actorId, active = true) {
    const roomId = this.hybridRoomData?.id || this.currentRoom?.roomData?.id || null;
    const pendingKey = `${roomId || 'global'}:${actorId}`;
    this.pendingActorStates[pendingKey] = active;
    const actor = this.npcs.find((npc) => npc.id === actorId && (!npc.roomId || npc.roomId === roomId));
    if (!actor) {
      console.warn(`Actor not ready in current room, queued state: ${actorId}`);
      return false;
    }
    actor.active = active;
    actor.root.visible = active;
    return true;
  },

  createPlacedModel(model, config) {
    const object = new THREE.Group();
    const visual = new THREE.Group();
    visual.rotation.copy(this.arrayToEuler(config.visualRotation, new THREE.Euler(0, 0, 0)));
    visual.scale.y = config.visualMirrorY ? -1 : 1;
    visual.add(model);
    object.add(visual);
    object.position.copy(config.position?.isVector3
      ? config.position
      : this.arrayToVector3(config.position, new THREE.Vector3()));
    object.rotation.y = config.rotationY ?? 0;
    object.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(object);
    const size = new THREE.Vector3();
    box.getSize(size);
    const targetHeight = config.height ?? this.getHybridActorHeight(config.heightScale ?? 1);
    visual.scale.multiplyScalar(targetHeight / (size.y || 1));

    object.updateMatrixWorld(true);
    const normalizedBox = new THREE.Box3().setFromObject(object);
    const center = new THREE.Vector3();
    normalizedBox.getCenter(center);
    visual.position.x -= center.x - object.position.x;
    visual.position.y -= normalizedBox.min.y - object.position.y;
    visual.position.z -= center.z - object.position.z;
    object.userData = {
      modelId: config.id,
      collisionRadius: Number.isFinite(config.collisionRadius) ? config.collisionRadius : null,
      collisionOffset: this.arrayToVector3(config.collisionOffset, new THREE.Vector3(0, 0, 0)),
    };
    return object;
  },

  createCharacterController(model) {
    const character = new THREE.Group();
    character.position.set(0, 0, 1);
    character.rotation.y = Math.PI;

    const visual = new THREE.Group();
    visual.rotation.copy(this.characterVisualRotation);
    visual.scale.y = this.characterVisualMirrorY ? -1 : 1;
    visual.add(model);
    character.add(visual);
    character.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(character);
    const size = new THREE.Vector3();
    box.getSize(size);
    const height = size.y || 1;
    const targetHeight = this.getHybridActorHeight(this.characterHeightScale);
    visual.scale.multiplyScalar(targetHeight / height);

    character.updateMatrixWorld(true);
    const normalizedBox = new THREE.Box3().setFromObject(character);
    const center = new THREE.Vector3();
    normalizedBox.getCenter(center);
    visual.position.x -= center.x - character.position.x;
    visual.position.y -= normalizedBox.min.y;
    visual.position.z -= center.z - character.position.z;
    return character;
  },

  placeCharacterAtRoomStart(character, spawnId = null) {
    const startPosition = this.getPlayerStartWorldPosition(spawnId);
    if (!startPosition) return;
    character.position.copy(startPosition);
    const start = this.getPlayerStartConfig(spawnId);
    if (start?.facing) {
      character.rotation.y = this.getFacingRotation(start.facing);
    }
  },

  getPlayerStartConfig(spawnId = null) {
    return (spawnId && this.hybridRoomData?.spawns?.[spawnId])
      || this.hybridRoomData?.playerStart
      || null;
  },

  getPlayerStartWorldPosition(spawnId = null) {
    const start = this.getPlayerStartConfig(spawnId);
    if (!start) return null;

    const markerPoint = this.getPlayerStartMarkerPoint(start);
    if (markerPoint) {
      const walkableMarkerPoint = this.findNearestWalkableRoomPoint(markerPoint);
      return this.getWorldPositionFromRoomPixel(walkableMarkerPoint || markerPoint);
    }

    if (!Number.isFinite(start.x) || !Number.isFinite(start.y)) return null;

    const startPoint = { x: start.x, y: start.y };
    const walkablePoint = this.findNearestWalkableRoomPoint(startPoint);
    return this.getWorldPositionFromRoomPixel(walkablePoint || startPoint);
  },

  getPlayerStartMarkerPoint(start) {
    const markerColor = start.markerColor || start.walkMaskColor;
    if (!markerColor || !this.hybridWalkMask) return null;
    return this.findWalkMaskColorMarker({
      color: markerColor,
      tolerance: start.markerTolerance ?? 8,
      minPixels: start.markerMinPixels ?? 4,
      maxPixels: start.markerMaxPixels ?? 2500,
      searchPadding: start.markerSearchPadding ?? 160,
      searchCenter: Number.isFinite(start.x) && Number.isFinite(start.y)
        ? { x: start.x, y: start.y }
        : null,
      searchRadius: start.markerSearchRadius,
    });
  },

  findWalkMaskColorMarker({
    color,
    tolerance = 8,
    minPixels = 4,
    maxPixels = 2500,
    searchPadding = 160,
    searchCenter = null,
    searchRadius = null,
  }) {
    const target = this.hexToRgb(color);
    if (!target || !this.hybridWalkMask) return null;
    const { canvas, context, walkableBounds } = this.hybridWalkMask;
    const bounds = walkableBounds || {
      minX: 0,
      minY: 0,
      maxX: canvas.width - 1,
      maxY: canvas.height - 1,
    };
    const searchMinX = Number.isFinite(searchCenter?.x) && Number.isFinite(searchRadius)
      ? searchCenter.x - searchRadius
      : bounds.minX - searchPadding;
    const searchMinY = Number.isFinite(searchCenter?.y) && Number.isFinite(searchRadius)
      ? searchCenter.y - searchRadius
      : bounds.minY - searchPadding;
    const searchMaxX = Number.isFinite(searchCenter?.x) && Number.isFinite(searchRadius)
      ? searchCenter.x + searchRadius
      : bounds.maxX + searchPadding;
    const searchMaxY = Number.isFinite(searchCenter?.y) && Number.isFinite(searchRadius)
      ? searchCenter.y + searchRadius
      : bounds.maxY + searchPadding;
    const minX = Math.max(0, Math.floor(searchMinX));
    const minY = Math.max(0, Math.floor(searchMinY));
    const maxX = Math.min(canvas.width - 1, Math.ceil(searchMaxX));
    const maxY = Math.min(canvas.height - 1, Math.ceil(searchMaxY));
    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    if (width <= 0 || height <= 0) return null;

    const image = context.getImageData(minX, minY, width, height).data;
    const visited = new Uint8Array(width * height);
    let best = null;
    const stack = [];

    const matches = (index) => {
      const offset = index * 4;
      const a = image[offset + 3];
      if (a < 16) return false;
      return Math.abs(image[offset] - target.r) <= tolerance
        && Math.abs(image[offset + 1] - target.g) <= tolerance
        && Math.abs(image[offset + 2] - target.b) <= tolerance;
    };

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const startIndex = y * width + x;
        if (visited[startIndex] || !matches(startIndex)) continue;

        let count = 0;
        let sumX = 0;
        let sumY = 0;
        let componentMinX = x;
        let componentMaxX = x;
        let componentMinY = y;
        let componentMaxY = y;
        stack.length = 0;
        stack.push(startIndex);
        visited[startIndex] = 1;

        while (stack.length) {
          const index = stack.pop();
          const px = index % width;
          const py = Math.floor(index / width);
          count += 1;
          sumX += px;
          sumY += py;
          componentMinX = Math.min(componentMinX, px);
          componentMaxX = Math.max(componentMaxX, px);
          componentMinY = Math.min(componentMinY, py);
          componentMaxY = Math.max(componentMaxY, py);

          [
            [px - 1, py],
            [px + 1, py],
            [px, py - 1],
            [px, py + 1],
          ].forEach(([nx, ny]) => {
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) return;
            const nextIndex = ny * width + nx;
            if (visited[nextIndex] || !matches(nextIndex)) return;
            visited[nextIndex] = 1;
            stack.push(nextIndex);
          });
        }

        const touchesSearchEdge = componentMinX === 0
          || componentMinY === 0
          || componentMaxX === width - 1
          || componentMaxY === height - 1;
        if (touchesSearchEdge || count < minPixels || count > maxPixels) continue;
        if (!best || count > best.count) {
          best = {
            count,
            x: minX + (sumX / count),
            y: minY + (sumY / count),
          };
        }
      }
    }

    return best ? { x: best.x, y: best.y } : null;
  },

  hexToRgb(hex) {
    if (typeof hex !== 'string') return null;
    const normalized = hex.trim().replace(/^#/, '');
    const value = normalized.length === 3
      ? normalized.split('').map((char) => char + char).join('')
      : normalized;
    if (!/^[\da-f]{6}$/i.test(value)) return null;
    const number = Number.parseInt(value, 16);
    return {
      r: (number >> 16) & 255,
      g: (number >> 8) & 255,
      b: number & 255,
    };
  },

  findNearestWalkableRoomPoint(point, maxRadius = null) {
    if (!this.hybridWalkMask) return point;
    if (this.isHybridPointWalkable(point)) return point;

    const { canvas } = this.hybridWalkMask;
    const step = 12;
    const radiusLimit = maxRadius || Math.max(canvas.width, canvas.height);
    for (let radius = step; radius <= radiusLimit; radius += step) {
      let best = null;
      let bestDistance = Infinity;
      for (let y = -radius; y <= radius; y += step) {
        for (let x = -radius; x <= radius; x += step) {
          if (Math.max(Math.abs(x), Math.abs(y)) !== radius) continue;
          const candidate = { x: point.x + x, y: point.y + y };
          if (!this.isHybridPointWalkable(candidate)) continue;
          const distance = Math.hypot(x, y);
          if (distance < bestDistance) {
            best = candidate;
            bestDistance = distance;
          }
        }
      }
      if (best) return best;
    }
    return null;
  },

  buildNavigationGrid(cellSize = 12) {
    if (!this.hybridWalkMask || !this.hybridRoomData?.id) return null;
    const roomId = this.hybridRoomData.id;
    const existing = this.navGrids[roomId];
    if (existing && existing.cellSize === cellSize) return existing;

    const { canvas } = this.hybridWalkMask;
    const cols = Math.ceil(canvas.width / cellSize);
    const rows = Math.ceil(canvas.height / cellSize);
    const walkable = new Uint8Array(cols * rows);
    let walkableCount = 0;

    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const point = {
          x: Math.min(canvas.width - 1, Math.round((col + 0.5) * cellSize)),
          y: Math.min(canvas.height - 1, Math.round((row + 0.5) * cellSize)),
        };
        const ok = this.isHybridPointWalkable(point);
        walkable[row * cols + col] = ok ? 1 : 0;
        if (ok) walkableCount += 1;
      }
    }

    const grid = { roomId, cellSize, width: canvas.width, height: canvas.height, cols, rows, walkable, walkableCount };
    this.navGrids[roomId] = grid;
    return grid;
  },

  getNavNodeFromRoomPoint(point, grid = this.buildNavigationGrid()) {
    if (!point || !grid) return null;
    const col = THREE.MathUtils.clamp(Math.floor(point.x / grid.cellSize), 0, grid.cols - 1);
    const row = THREE.MathUtils.clamp(Math.floor(point.y / grid.cellSize), 0, grid.rows - 1);
    return { col, row, index: row * grid.cols + col };
  },

  getRoomPointFromNavNode(node, grid = this.buildNavigationGrid()) {
    if (!node || !grid) return null;
    return {
      x: Math.min(grid.width - 1, (node.col + 0.5) * grid.cellSize),
      y: Math.min(grid.height - 1, (node.row + 0.5) * grid.cellSize),
    };
  },

  findNearestWalkableNavNode(point, grid = this.buildNavigationGrid(), maxRadiusCells = 80) {
    const start = this.getNavNodeFromRoomPoint(point, grid);
    if (!start) return null;
    if (grid.walkable[start.index]) return start;

    let best = null;
    let bestDistance = Infinity;
    for (let radius = 1; radius <= maxRadiusCells; radius += 1) {
      for (let row = start.row - radius; row <= start.row + radius; row += 1) {
        for (let col = start.col - radius; col <= start.col + radius; col += 1) {
          if (row < 0 || row >= grid.rows || col < 0 || col >= grid.cols) continue;
          if (Math.max(Math.abs(col - start.col), Math.abs(row - start.row)) !== radius) continue;
          const index = row * grid.cols + col;
          if (!grid.walkable[index]) continue;
          const distance = Math.hypot((col - start.col) * grid.cellSize, (row - start.row) * grid.cellSize);
          if (distance < bestDistance) {
            best = { col, row, index };
            bestDistance = distance;
          }
        }
      }
      if (best) return best;
    }
    return null;
  },

  findPathRoomPixels(startPoint, goalPoint) {
    const grid = this.buildNavigationGrid();
    if (!grid || !startPoint || !goalPoint) return null;
    const start = this.findNearestWalkableNavNode(startPoint, grid);
    const goal = this.findNearestWalkableNavNode(goalPoint, grid);
    if (!start || !goal) return null;
    if (start.index === goal.index) return [this.getRoomPointFromNavNode(goal, grid)];

    const total = grid.cols * grid.rows;
    const cameFrom = new Int32Array(total);
    const gScore = new Float32Array(total);
    const fScore = new Float32Array(total);
    const inOpen = new Uint8Array(total);
    const closed = new Uint8Array(total);
    cameFrom.fill(-1);
    gScore.fill(Infinity);
    fScore.fill(Infinity);

    const heuristic = (index) => {
      const col = index % grid.cols;
      const row = Math.floor(index / grid.cols);
      return Math.hypot(col - goal.col, row - goal.row);
    };
    const open = [start.index];
    inOpen[start.index] = 1;
    gScore[start.index] = 0;
    fScore[start.index] = heuristic(start.index);
    const dirs = [
      [0, -1, 1], [1, 0, 1], [0, 1, 1], [-1, 0, 1],
      [1, -1, Math.SQRT2], [1, 1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
    ];

    while (open.length) {
      let bestOpen = 0;
      for (let i = 1; i < open.length; i += 1) {
        if (fScore[open[i]] < fScore[open[bestOpen]]) bestOpen = i;
      }
      const current = open.splice(bestOpen, 1)[0];
      inOpen[current] = 0;
      if (current === goal.index) {
        const path = [];
        let node = current;
        while (node !== -1) {
          path.push(this.getRoomPointFromNavNode({ col: node % grid.cols, row: Math.floor(node / grid.cols), index: node }, grid));
          node = cameFrom[node];
        }
        return path.reverse();
      }
      closed[current] = 1;
      const currentCol = current % grid.cols;
      const currentRow = Math.floor(current / grid.cols);
      for (const [dx, dy, cost] of dirs) {
        const col = currentCol + dx;
        const row = currentRow + dy;
        if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) continue;
        const next = row * grid.cols + col;
        if (closed[next] || !grid.walkable[next]) continue;
        if (dx !== 0 && dy !== 0) {
          const sideA = currentRow * grid.cols + col;
          const sideB = row * grid.cols + currentCol;
          if (!grid.walkable[sideA] || !grid.walkable[sideB]) continue;
        }
        const tentative = gScore[current] + cost;
        if (tentative >= gScore[next]) continue;
        cameFrom[next] = current;
        gScore[next] = tentative;
        fScore[next] = tentative + heuristic(next);
        if (!inOpen[next]) {
          open.push(next);
          inOpen[next] = 1;
        }
      }
    }
    return null;
  },

  hasLineOfSightWalkable(a, b) {
    if (!a || !b) return false;
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const step = Math.max(4, (this.buildNavigationGrid()?.cellSize || 12) * 0.5);
    const steps = Math.max(1, Math.ceil(distance / step));
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const point = { x: THREE.MathUtils.lerp(a.x, b.x, t), y: THREE.MathUtils.lerp(a.y, b.y, t) };
      if (!this.isHybridPointWalkable(point)) return false;
    }
    return true;
  },

  simplifyPath(path = []) {
    if (!path.length) return [];
    const simplified = [path[0]];
    let anchorIndex = 0;
    for (let index = 2; index < path.length; index += 1) {
      if (!this.hasLineOfSightWalkable(path[anchorIndex], path[index])) {
        simplified.push(path[index - 1]);
        anchorIndex = index - 1;
      }
    }
    if (path.length > 1) simplified.push(path[path.length - 1]);
    return simplified;
  },

  getWalkPathToRoomPoint(goalPoint, { maxRadius = null } = {}) {
    if (!this.character || !goalPoint) return null;
    const startPoint = this.getRoomPixelFromWorldPosition(this.character.position);
    const destination = this.isHybridPointWalkable(goalPoint)
      ? goalPoint
      : this.findNearestWalkableRoomPoint(goalPoint, maxRadius);
    if (!destination) return null;
    const rawPath = this.findPathRoomPixels(startPoint, destination);
    if (!rawPath?.length) return null;
    const path = this.simplifyPath(rawPath);
    const worldPath = path
      .map((point) => this.getWorldPositionFromRoomPixel(point))
      .filter(Boolean);
    this.currentPathDebug = { roomId: this.hybridRoomData?.id, startPoint, goalPoint, destination, rawPath, path, worldPath };
    return worldPath;
  },

  getWalkPathFromPointer(event) {
    if (!this.currentRoom) return null;
    if (!this.hybridRoomData?.hybrid3d) {
      const target = this.getWalkTargetFromPointer(event);
      return target ? [target] : null;
    }
    return this.getWalkPathToRoomPoint(this.getRoomPixelFromPointer(event));
  },

  getFacingRotation(facing) {
    const rotations = {
      up: Math.PI,
      down: 0,
      left: -Math.PI * 0.5,
      right: Math.PI * 0.5,
    };
    return rotations[facing] ?? Math.PI;
  },

  createFallbackCharacter() {
    const character = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.28, 0.9, 3, 6),
      new THREE.MeshStandardMaterial({ color: 0x7e8f77, roughness: 0.9 })
    );
    body.position.y = 0.85;
    character.add(body);

    const facing = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.16, 0.2),
      new THREE.MeshStandardMaterial({ color: 0xe8e0d1, roughness: 1 })
    );
    facing.position.set(0, 1.25, -0.28);
    character.add(facing);

    character.position.set(0, 0, 1);
    character.rotation.y = -Math.PI;
    return character;
  },

  enterRoom(roomId, spawnId = null) {
    this.currentRoom = this.rooms[roomId];
    if (!this.currentRoom) return;
    this.activateRoomData(this.currentRoom);
    this.setCameraForRoom(this.currentRoom);
    this.configureWalkPlaneForCamera(this.currentRoom.camera);
    this.calibrateHybridActorHeight(this.currentRoom.camera);
    this.placeCharacterForCurrentRoom(spawnId);
    AudioManager.playForRoom(this.currentRoom);
    if (this.character && !this.isWorldPositionWalkable(this.character.position)) {
      this.placeCharacterAtRoomStart(this.character, spawnId);
    }
    this.updateStatus();
    InteractionEngine.runRoomEnter(this.currentRoom.roomData || this.hybridRoomData);
  },

  placeCharacterForCurrentRoom(spawnId = null) {
    if (!this.character || !this.currentRoom?.scene) return;
    this.currentRoom.scene.add(this.character);
    if (this.currentRoom.roomData) {
      this.placeCharacterAtRoomStart(this.character, spawnId);
    }
  },

  setCameraForRoom(room) {
    room.camera.position.copy(room.fixedCamera.position);
    room.camera.lookAt(room.fixedCamera.target);
    room.camera.updateMatrixWorld(true);
    room.camera.updateProjectionMatrix();
  },

  handleClick(event, queueArrival = null) {
    if (!this.currentRoom) return false;
    if (NarratorVoice.isBusy()) return true;
    const exit = this.getExitFromPointer(event);
    if (exit) {
      this.queueInteractionOrRun(exit, queueArrival);
      return true;
    }
    const hotspot = this.getHotspotFromPointer(event);
    if (hotspot) {
      this.queueInteractionOrRun(hotspot, queueArrival);
      return true;
    }
    const interest = this.getInterestFromPointer(event);
    if (interest) {
      this.queueInteractionOrRun(interest, queueArrival);
      return true;
    }

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.currentRoom.camera);
    const hits = this.raycaster.intersectObjects(this.currentRoom.scene.children, true);
    if (hits.length) {
      const hit = hits
        .map((entry) => this.findInteractionObject(entry.object))
        .find(Boolean);
      if (hit) {
        InteractionEngine.process(hit.userData.interactionId, hit.userData);
        return true;
      }
    }
    return false;
  },

  handleGamepadActivate(queueArrival = null) {
    if (!this.currentRoom || !this.character) return false;
    if (NarratorVoice.isBusy()) return true;
    const interest = this.getGamepadFocusedInteraction();
    if (!interest) {
      NarratorVoice.setAmbientText('Romeo reaches for nothing useful.');
      return false;
    }
    this.queueInteractionOrRun(interest, queueArrival);
    return true;
  },

  getGamepadFocusedInteraction() {
    if (!this.character) return null;
    const characterPoint = this.getRoomPixelFromWorldPosition(this.character.position);
    if (!characterPoint) return null;

    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.character.quaternion);
    const aheadPosition = this.character.position.clone().addScaledVector(forward, 0.9);
    aheadPosition.y = this.getWalkSurfaceYAt(aheadPosition);
    const aheadPoint = this.getRoomPixelFromWorldPosition(aheadPosition) || characterPoint;
    const midpoint = {
      x: (characterPoint.x + aheadPoint.x) * 0.5,
      y: (characterPoint.y + aheadPoint.y) * 0.5,
    };

    const directPoints = [aheadPoint, midpoint, characterPoint];
    for (const point of directPoints) {
      const direct = this.getExitAtRoomPoint(point)
        || this.getHotspotAtRoomPoint(point)
        || this.getInterestNearRoomPoint(point, 18);
      if (direct) return direct;
    }

    return this.getNearestRectInteraction(aheadPoint, characterPoint, 130);
  },

  getInterestNearRoomPoint(point, radius = 18) {
    const offsets = [
      [0, 0],
      [radius, 0],
      [-radius, 0],
      [0, radius],
      [0, -radius],
      [radius * 0.7, radius * 0.7],
      [-radius * 0.7, radius * 0.7],
      [radius * 0.7, -radius * 0.7],
      [-radius * 0.7, -radius * 0.7],
    ];
    for (const [x, y] of offsets) {
      const interest = this.getInterestAtRoomPoint({ x: point.x + x, y: point.y + y });
      if (interest) return interest;
    }
    return null;
  },

  getNearestRectInteraction(focusPoint, fallbackPoint, maxDistance = 130) {
    const candidates = [
      ...(this.hybridRoomData?.exits || []).map((entry) => ({ type: 'exit', entry })),
      ...(this.hybridRoomData?.hotspots || []).map((entry) => ({ type: 'hotspot', entry })),
    ];
    let best = null;
    for (const candidate of candidates) {
      const rect = candidate.entry.rect;
      if (!Array.isArray(rect) || rect.length < 4) continue;
      const distance = Math.min(
        this.getDistanceToRoomRect(focusPoint, rect),
        this.getDistanceToRoomRect(fallbackPoint, rect)
      );
      if (distance > maxDistance) continue;
      if (!best || distance < best.distance) {
        best = { ...candidate, distance };
      }
    }
    if (!best) return null;
    const rect = best.entry.rect;
    const point = {
      x: THREE.MathUtils.clamp(focusPoint.x, rect[0], rect[0] + rect[2]),
      y: THREE.MathUtils.clamp(focusPoint.y, rect[1], rect[1] + rect[3]),
    };
    return best.type === 'exit'
      ? this.getExitAtRoomPoint(point)
      : this.getHotspotAtRoomPoint(point);
  },

  getDistanceToRoomRect(point, rect) {
    const [x, y, width, height] = rect;
    const clampedX = THREE.MathUtils.clamp(point.x, x, x + width);
    const clampedY = THREE.MathUtils.clamp(point.y, y, y + height);
    return Math.hypot(point.x - clampedX, point.y - clampedY);
  },

  queueInteractionOrRun(interest, queueArrival = null) {
    if (!this.hybridRoomData?.hybrid3d || !queueArrival || !this.character) {
      this.processInterest(interest);
      return;
    }
    const approach = this.getInteractionApproachPath(interest);
    if (approach?.alreadyInReach) {
      this.processInterest(interest);
      return;
    }
    const path = approach?.path;
    if (!path?.length) {
      NarratorVoice.setAmbientText('Romeo studies the route. No.');
      return;
    }
    queueArrival(path, () => this.processInterest(interest));
  },

  getInteractionApproachPath(interest) {
    const anchor = this.getInteractionAnchorPoint(interest);
    const characterPoint = this.getRoomPixelFromWorldPosition(this.character?.position);
    if (!anchor || !characterPoint) return null;

    const rect = interest?.rect || interest?.exit?.rect || interest?.hotspot?.rect;
    const reach = Number.isFinite(interest?.interactionReach)
      ? interest.interactionReach
      : (Array.isArray(rect) ? 185 : 230);
    if (Math.hypot(anchor.x - characterPoint.x, anchor.y - characterPoint.y) <= reach) {
      return { alreadyInReach: true, anchor };
    }

    const candidates = this.getInteractionApproachCandidates(interest, anchor);
    let best = null;
    for (const candidate of candidates) {
      const maxRadius = Number.isFinite(interest?.approachRadius) ? interest.approachRadius : 340;
      const path = this.getWalkPathToRoomPoint(candidate, { maxRadius });
      if (!path?.length) continue;
      const finalPoint = this.getRoomPixelFromWorldPosition(path[path.length - 1]);
      const interactionDistance = finalPoint ? Math.hypot(finalPoint.x - anchor.x, finalPoint.y - anchor.y) : Infinity;
      if (interactionDistance > Math.max(reach * 1.65, maxRadius)) continue;
      const length = this.getWorldPathLength(path);
      if (!best || length < best.length) {
        best = { path, length, anchor, candidate, interactionDistance };
      }
    }
    return best;
  },

  getInteractionApproachCandidates(interest, anchor) {
    const rect = interest?.rect || interest?.exit?.rect || interest?.hotspot?.rect;
    if (!Array.isArray(rect) || rect.length < 4) {
      return [anchor];
    }

    const [x, y, width, height] = rect;
    const centerX = x + width / 2;
    const centerY = y + height / 2;
    const bottomY = y + height - 10;
    const belowY = y + height + 36;
    const sideInset = Math.min(width * 0.25, 55);
    return [
      anchor,
      { x: centerX, y: bottomY },
      { x: centerX, y: belowY },
      { x: x + sideInset, y: bottomY },
      { x: x + width - sideInset, y: bottomY },
      { x: x - 36, y: centerY },
      { x: x + width + 36, y: centerY },
      { x: centerX, y: centerY },
    ];
  },

  getWorldPathLength(path = []) {
    let length = 0;
    let previous = this.character?.position || null;
    for (const point of path) {
      if (previous) length += Math.hypot(point.x - previous.x, point.z - previous.z);
      previous = point;
    }
    return length;
  },

  getInteractionAnchorPoint(interest) {
    const rect = interest?.rect || interest?.exit?.rect || interest?.hotspot?.rect;
    if (Array.isArray(rect) && rect.length >= 4) {
      return { x: rect[0] + rect[2] / 2, y: rect[1] + rect[3] - 12 };
    }
    return interest?.point || this.getRoomPixelFromWorldPosition(this.character?.position);
  },

  handlePointerHover(event) {
    const interest = this.getExitFromPointer(event) || this.getHotspotFromPointer(event) || this.getInterestFromPointer(event);
    const id = interest?.id || null;
    if (id === this.hoverInterestId) {
      if (interest?.label && !NarratorVoice.isBusy() && NarratorVoice.textElement?.textContent !== `${interest.label}.`) {
        NarratorVoice.setInstantText(`${interest.label}.`);
      }
      return;
    }
    this.hoverInterestId = id;
    const canvas = this.renderer.domElement;
    canvas.style.cursor = interest ? 'pointer' : 'crosshair';
    if (interest?.label && !NarratorVoice.isBusy()) {
      NarratorVoice.setInstantText(`${interest.label}.`);
    }
  },

  getInterestFromPointer(event) {
    if (!this.hybridInterestMap || !this.hybridRoomData?.interests) return null;
    return this.getInterestAtRoomPoint(this.getRoomPixelFromPointer(event));
  },

  getExitFromPointer(event) {
    return this.getExitAtRoomPoint(this.getRoomPixelFromPointer(event));
  },

  getHotspotFromPointer(event) {
    return this.getHotspotAtRoomPoint(this.getRoomPixelFromPointer(event));
  },

  getExitAtRoomPoint(point) {
    if (!point || !Array.isArray(this.hybridRoomData?.exits)) return null;
    const exit = this.hybridRoomData.exits.find((candidate) => {
      const [x, y, width, height] = candidate.rect || [];
      return Number.isFinite(x)
        && Number.isFinite(y)
        && Number.isFinite(width)
        && Number.isFinite(height)
        && point.x >= x
        && point.x <= x + width
        && point.y >= y
        && point.y <= y + height;
    });
    if (!exit) return null;
    const doorInterest = this.hybridRoomData?.interests?.['#ff0000'] || {};
    const action = exit.action || exit.interaction || doorInterest.action || exit;
    return {
      ...doorInterest,
      ...exit,
      id: exit.id || doorInterest.id,
      label: exit.label || doorInterest.label || 'Door',
      cursor: doorInterest.cursor || 'exit',
      action,
      targetRoom: exit.targetRoom,
      targetSpawn: exit.targetSpawn,
      point,
      exit,
    };
  },

  getHotspotAtRoomPoint(point) {
    if (!point || !Array.isArray(this.hybridRoomData?.hotspots)) return null;
    const hotspot = this.hybridRoomData.hotspots.find((candidate) => {
      const [x, y, width, height] = candidate.rect || [];
      return Number.isFinite(x)
        && Number.isFinite(y)
        && Number.isFinite(width)
        && Number.isFinite(height)
        && point.x >= x
        && point.x <= x + width
        && point.y >= y
        && point.y <= y + height;
    });
    if (!hotspot) return null;
    return {
      ...hotspot,
      ...(hotspot.interaction && typeof hotspot.interaction === 'object' ? hotspot.interaction : {}),
      id: hotspot.id,
      label: hotspot.label,
      cursor: hotspot.cursor,
      action: hotspot.action || hotspot.interaction?.action || hotspot.interaction,
      targetRoom: hotspot.targetRoom || hotspot.interaction?.targetRoom,
      targetSpawn: hotspot.targetSpawn || hotspot.interaction?.targetSpawn,
      voice: hotspot.voice || hotspot.interaction?.voice,
      enterVoice: hotspot.enterVoice ?? hotspot.interaction?.enterVoice,
      anim: hotspot.anim ?? hotspot.interaction?.anim,
      text: hotspot.text || hotspot.interaction?.text,
      point,
      hotspot,
    };
  },

  getInterestAtRoomPoint(point) {
    const sample = this.samplePixelMap(this.hybridInterestMap, point);
    if (!sample || sample.a < 16) return null;
    const color = this.rgbToHex(sample.r, sample.g, sample.b);
    const interest = this.hybridRoomData?.interests?.[color];
    if (color === '#000000' && !interest) return null;
    return interest ? { ...interest, color, point, sample } : null;
  },

  processInterest(interest) {
    if (interest.action) {
      InteractionEngine.process(interest.action, interest);
      return;
    }
    if (InteractionEngine.hasActionFields(interest)) {
      InteractionEngine.runAction(interest, interest);
      return;
    }
    this.playInteractionAnimation(interest.anim ?? null);
    NarratorVoice.speak(
      interest.text || `Romeo studies the ${interest.label || 'thing'} and decides it can wait.`,
      [{ label: 'Continue', action: () => { } }],
      { voice: interest.voice }
    );
  },

  findInteractionObject(object) {
    let current = object;
    while (current) {
      if (current.userData?.interactionId) return current;
      current = current.parent;
    }
    return null;
  },

  getWalkTargetFromPointer(event) {
    if (!this.currentRoom) return null;
    if (this.hybridRoomData?.hybrid3d) {
      return this.getHybridWalkTargetFromPointer(event);
    }

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.currentRoom.camera);

    const target = new THREE.Vector3();
    const didHitFloor = this.raycaster.ray.intersectPlane(this.walkPlane, target);
    if (!didHitFloor) return null;

    target.x = THREE.MathUtils.clamp(target.x, -4.1, 4.1);
    target.z = THREE.MathUtils.clamp(target.z, -4.05, 4.1);
    return target;
  },

  getHybridWalkTargetFromPointer(event) {
    const point = this.getRoomPixelFromPointer(event);
    if (!this.isHybridPointWalkable(point)) return null;

    return this.getWorldPositionFromRoomPixel(point);
  },

  getHybridWalkScreenBounds() {
    if (this.hybridWalkMask?.walkableBounds) return this.hybridWalkMask.walkableBounds;

    const walkArea = this.hybridRoomData?.walkArea || [];
    if (!walkArea.length) return null;
    const xs = walkArea.map((entry) => entry[0]);
    const ys = walkArea.map((entry) => entry[1]);
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    };
  },

  isHybridPointWalkable(point) {
    if (!point) return false;
    if (this.hybridWalkMask) {
      return this.isWalkMaskPixelWalkable(point);
    }

    const room = this.hybridRoomData;
    if (!this.isPointInPolygon([point.x, point.y], room.walkArea || [])) return false;
    if (this.isPointInWalkObstacle(point, room.walkObstacles)) return false;
    return true;
  },

  isWalkMaskPixelWalkable(point) {
    const sample = this.sampleWalkMask(point);
    if (!sample) return false;
    return this.isWalkMaskRgbaWalkable(sample.r, sample.g, sample.b, sample.a);
  },

  isWalkMaskRgbaWalkable(r, g, b, a) {
    const mode = this.hybridWalkMask?.mode || 'painted-walkable';
    const redBlocked = r > 160 && g < 95 && b < 95;
    if (mode === 'red-blocked') {
      return a >= 16 && !redBlocked;
    }

    if (a < 16) return false;
    if (redBlocked) return false;
    const brightWalkable = r > 140 && g > 140 && b > 140;
    if (brightWalkable) return true;
    const greenWalkable = g > 140 && r < 120 && b < 140;
    return greenWalkable;
  },

  getWalkMaskMode(roomData) {
    return roomData?.layers?.walkMaskMode || roomData?.walkMaskMode || 'painted-walkable';
  },

  getWalkMaskWalkableBounds(canvas, context, mode = this.hybridWalkMask?.mode || 'painted-walkable') {
    const image = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const bounds = {
      minX: canvas.width,
      maxX: 0,
      minY: canvas.height,
      maxY: 0,
    };
    let found = false;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const index = (y * canvas.width + x) * 4;
        if (!this.isWalkMaskRgbaWalkableForMode(image[index], image[index + 1], image[index + 2], image[index + 3], mode)) continue;
        bounds.minX = Math.min(bounds.minX, x);
        bounds.maxX = Math.max(bounds.maxX, x);
        bounds.minY = Math.min(bounds.minY, y);
        bounds.maxY = Math.max(bounds.maxY, y);
        found = true;
      }
    }
    return found ? bounds : null;
  },

  isWalkMaskRgbaWalkableForMode(r, g, b, a, mode) {
    const redBlocked = r > 160 && g < 95 && b < 95;
    if (mode === 'red-blocked') return a >= 16 && !redBlocked;
    if (a < 16 || redBlocked) return false;
    return (r > 140 && g > 140 && b > 140) || (g > 140 && r < 120 && b < 140);
  },

  sampleWalkMask(point) {
    if (!this.hybridWalkMask) return null;
    const { canvas, context } = this.hybridWalkMask;
    const x = Math.round(point.x);
    const y = Math.round(point.y);
    if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height) return null;
    const [r, g, b, a] = context.getImageData(x, y, 1, 1).data;
    return { x, y, r, g, b, a };
  },

  debugWalkMaskAt(x, y) {
    const point = { x, y };
    const sample = this.sampleWalkMask(point);
    return {
      point,
      sample,
      usesMask: Boolean(this.hybridWalkMask),
      walkable: this.isHybridPointWalkable(point),
    };
  },

  debugWalkMaskWorld(x, z) {
    const position = new THREE.Vector3(x, 0, z);
    const point = this.getRoomPixelFromWorldPosition(position);
    const sample = this.sampleWalkMask(point);
    return {
      world: { x, z },
      point,
      sample,
      walkable: this.isWorldPositionWalkable(position),
    };
  },

  debugWorldFromRoomPixel(x, y) {
    const point = { x, y };
    const pixel = this.debugWalkMaskAt(x, y);
    const position = this.getWorldPositionFromRoomPixel(point);
    const roundTripPoint = position ? this.getRoomPixelFromWorldPosition(position) : null;
    return {
      point,
      pixel,
      world: position ? { x: position.x, y: position.y, z: position.z } : null,
      roundTripPoint,
      roundTripPixel: roundTripPoint ? this.debugWalkMaskAt(roundTripPoint.x, roundTripPoint.y) : null,
      walkable: pixel.walkable && position ? this.isWorldPositionWalkable(position) : false,
    };
  },

  debugInterestAt(x, y) {
    return this.getInterestAtRoomPoint({ x, y });
  },

  debugPlayerStart() {
    const start = this.hybridRoomData?.playerStart;
    const markerPoint = start ? this.getPlayerStartMarkerPoint(start) : null;
    const jsonPoint = start && Number.isFinite(start.x) && Number.isFinite(start.y)
      ? { x: start.x, y: start.y }
      : null;
    const chosenPoint = markerPoint || jsonPoint;
    const walkablePoint = chosenPoint ? this.findNearestWalkableRoomPoint(chosenPoint) : null;
    const world = walkablePoint ? this.getWorldPositionFromRoomPixel(walkablePoint) : null;
    return {
      start,
      markerPoint,
      jsonPoint,
      chosenPoint,
      walkablePoint,
      world: world ? { x: world.x, y: world.y, z: world.z } : null,
    };
  },

  samplePixelMap(pixelMap, point) {
    if (!pixelMap) return null;
    const { canvas, context } = pixelMap;
    const x = Math.round(point.x);
    const y = Math.round(point.y);
    if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height) return null;
    const [r, g, b, a] = context.getImageData(x, y, 1, 1).data;
    return { x, y, r, g, b, a };
  },

  rgbToHex(r, g, b) {
    return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
  },

  getRoomPixelFromPointer(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const width = this.hybridRoomData?.camera?.width || 1920;
    const height = this.hybridRoomData?.camera?.height || 1080;
    const plateRect = this.getRoomPlateScreenRect(rect);
    const localX = (event.clientX - plateRect.left) / plateRect.width;
    const localY = (event.clientY - plateRect.top) / plateRect.height;

    return {
      x: localX * width,
      y: localY * height,
    };
  },

  getWorldPositionFromRoomPixel(point) {
    const camera = this.currentRoom?.camera || this.rooms.placeholderRoom?.camera;
    if (!camera || !point) return null;
    return this.getFloorPositionFromRoomPixel(point)
      || this.getNearestReachableFloorPosition(point);
  },

  getFloorPositionFromRoomPixel(point) {
    const camera = this.currentRoom?.camera || this.rooms.placeholderRoom?.camera;
    if (!camera || !point) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const width = this.hybridRoomData?.camera?.width || 1920;
    const height = this.hybridRoomData?.camera?.height || 1080;
    const plateRect = this.getRoomPlateScreenRect(rect);
    const screenX = plateRect.left + (point.x / width) * plateRect.width;
    const screenY = plateRect.top + (point.y / height) * plateRect.height;

    this.pointer.x = ((screenX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((screenY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, camera);

    const target = new THREE.Vector3();
    const didHitFloor = this.raycaster.ray.intersectPlane(this.walkPlane, target);
    return didHitFloor ? target : null;
  },

  getNearestReachableFloorPosition(point) {
    if (!this.hybridWalkMask) return null;
    const { canvas } = this.hybridWalkMask;
    const step = 4;
    const maxDistance = canvas.height;

    for (let distance = step; distance <= maxDistance; distance += step) {
      const candidates = [
        { x: point.x, y: point.y - distance },
        { x: point.x, y: point.y + distance },
      ];

      for (const candidate of candidates) {
        if (candidate.y < 0 || candidate.y >= canvas.height) continue;
        if (!this.isHybridPointWalkable(candidate)) continue;
        const position = this.getFloorPositionFromRoomPixel(candidate);
        if (position) return position;
      }
    }

    return null;
  },

  getRoomPixelFromWorldPosition(position) {
    const camera = this.currentRoom?.camera;
    if (!camera) return null;

    const rect = this.renderer.domElement.getBoundingClientRect();
    const width = this.hybridRoomData?.camera?.width || 1920;
    const height = this.hybridRoomData?.camera?.height || 1080;
    const projected = position.clone().project(camera);
    const screenX = rect.left + ((projected.x + 1) * 0.5 * rect.width);
    const screenY = rect.top + ((1 - projected.y) * 0.5 * rect.height);
    const plateRect = this.getRoomPlateScreenRect(rect);

    return {
      x: ((screenX - plateRect.left) / plateRect.width) * width,
      y: ((screenY - plateRect.top) / plateRect.height) * height,
    };
  },

  isWorldPositionWalkable(position) {
    if (!this.hybridRoomData?.hybrid3d) return true;
    return this.isHybridPointWalkable(this.getRoomPixelFromWorldPosition(position));
  },

  canMoveToWorldPosition(position, fromPosition = null) {
    if (!this.hybridRoomData?.hybrid3d) return true;
    return this.isWorldPositionWalkable(position) && this.isPositionClearOfNPCs(position, fromPosition);
  },

  canNPCMoveToWorldPosition(position) {
    if (!this.hybridRoomData?.hybrid3d) return true;
    return this.isWorldPositionWalkable(position);
  },

  isPositionClearOfNPCs(position, fromPosition = null) {
    const activeNPCs = this.getActiveNPCs();
    const propBlockers = this.getActivePropBlockers();
    if (!position || (!activeNPCs.length && !propBlockers.length)) return true;
    const playerRadius = this.characterCollisionRadius;

    return [...activeNPCs, ...propBlockers].every((blocker) => {
      const npcPosition = blocker.root?.position || blocker.position;
      if (!npcPosition) return true;
      const minDistance = playerRadius + (blocker.collisionRadius ?? this.npcCollisionRadius);
      const candidateDistance = Math.hypot(position.x - npcPosition.x, position.z - npcPosition.z);
      if (candidateDistance >= minDistance) return true;

      if (!fromPosition) return false;
      const currentDistance = Math.hypot(fromPosition.x - npcPosition.x, fromPosition.z - npcPosition.z);
      return candidateDistance >= currentDistance;
    });
  },

  getActivePropBlockers(roomId = this.hybridRoomData?.id || this.currentRoom?.roomData?.id || null) {
    return this.placedModels
      .filter((object) => object.visible !== false
        && (!roomId || object.roomId === roomId)
        && Number.isFinite(object.userData?.collisionRadius))
      .map((object) => ({
        id: object.userData.modelId,
        position: object.userData.collisionOffset
          ? object.position.clone().add(object.userData.collisionOffset)
          : object.position,
        collisionRadius: object.userData.collisionRadius,
        movable: false,
      }));
  },

  resolveActorOverlaps() {
    const activeNPCs = this.getActiveNPCs();
    const propBlockers = this.getActivePropBlockers();
    if (!activeNPCs.length && !propBlockers.length) return;
    const actors = [
      ...activeNPCs.map((npc) => ({
        position: npc.root.position,
        radius: npc.collisionRadius ?? this.npcCollisionRadius,
        movable: true,
      })),
      ...propBlockers.map((prop) => ({
        position: prop.position,
        radius: prop.collisionRadius,
        movable: false,
      })),
      ...(this.character ? [{
        position: this.character.position,
        radius: this.characterCollisionRadius,
        movable: false,
      }] : []),
    ];

    for (let pass = 0; pass < 8; pass += 1) {
      for (let a = 0; a < actors.length; a += 1) {
        for (let b = a + 1; b < actors.length; b += 1) {
          this.separateActors(actors[a], actors[b]);
        }
      }
    }
  },

  separateActors(a, b) {
    const dx = b.position.x - a.position.x;
    const dz = b.position.z - a.position.z;
    const distance = Math.hypot(dx, dz);
    const minDistance = a.radius + b.radius;
    if (distance >= minDistance || (!a.movable && !b.movable)) return;

    const overlap = minDistance - distance;
    const nx = distance > 0.0001 ? dx / distance : 1;
    const nz = distance > 0.0001 ? dz / distance : 0;
    const aShare = a.movable && b.movable ? 0.5 : (a.movable ? 1 : 0);
    const bShare = a.movable && b.movable ? 0.5 : (b.movable ? 1 : 0);

    if (aShare > 0) this.moveActorBy(a, -nx * overlap * aShare, -nz * overlap * aShare);
    if (bShare > 0) this.moveActorBy(b, nx * overlap * bShare, nz * overlap * bShare);
  },

  moveActorBy(actor, dx, dz) {
    const next = actor.position.clone();
    next.x += dx;
    next.z += dz;
    if (this.hybridRoomData?.hybrid3d && !this.isWorldPositionWalkable(next)) return;
    actor.position.copy(next);
    actor.position.y = this.getWalkSurfaceYAt(actor.position);
  },

  debugActorSpacing() {
    const activeNPCs = this.getActiveNPCs();
    const actors = [
      ...(this.character ? [{
        id: 'player',
        position: this.character.position,
        radius: this.characterCollisionRadius,
        visible: this.character.visible,
      }] : []),
      ...activeNPCs.map((npc) => ({
        id: npc.id,
        position: npc.root.position,
        radius: npc.collisionRadius ?? this.npcCollisionRadius,
        visible: npc.root.visible,
        roomId: npc.roomId,
      })),
    ];
    const pairs = [];
    for (let a = 0; a < actors.length; a += 1) {
      for (let b = a + 1; b < actors.length; b += 1) {
        const first = actors[a];
        const second = actors[b];
        pairs.push({
          a: first.id,
          b: second.id,
          distance: Math.hypot(first.position.x - second.position.x, first.position.z - second.position.z),
          minimum: first.radius + second.radius,
        });
      }
    }
    return {
      actors: actors.map((actor) => ({
        id: actor.id,
        radius: actor.radius,
        visible: actor.visible,
        roomId: actor.roomId,
        x: actor.position.x,
        z: actor.position.z,
      })),
      pairs,
    };
  },

  debugRooms() {
    return Object.fromEntries(Object.entries(this.rooms).map(([id, room]) => [
      id,
      {
        id: room.id,
        name: room.name,
        roomDataId: room.roomData?.id || null,
        packageType: this.roomPackages[room.roomData?.id]?.type || null,
        walkMask: room.walkMask ? {
          width: room.walkMask.canvas.width,
          height: room.walkMask.canvas.height,
          mode: room.walkMask.mode,
          walkableBounds: room.walkMask.walkableBounds,
        } : null,
        hasInterestMap: Boolean(room.interestMap),
        sceneChildren: room.scene?.children.length || 0,
        cameraChildren: room.camera?.children.map((child) => ({
          type: child.type,
          renderOrder: child.renderOrder,
          hasMap: Boolean(child.material?.uniforms?.map?.value),
        })) || [],
      },
    ]));
  },

  debugActorScale() {
    const measure = (object) => {
      if (!object || !this.currentRoom?.camera) return null;
      const box = new THREE.Box3().setFromObject(object);
      const size = new THREE.Vector3();
      box.getSize(size);
      const bottom = new THREE.Vector3(0, box.min.y, 0);
      const top = new THREE.Vector3(0, box.max.y, 0);
      bottom.project(this.currentRoom.camera);
      top.project(this.currentRoom.camera);
      const canvasHeight = this.renderer.domElement.getBoundingClientRect().height || window.innerHeight || 1;
      return {
        worldHeight: size.y,
        screenHeight: Math.abs(top.y - bottom.y) * 0.5 * canvasHeight,
      };
    };
    return {
      calibratedActorHeight: this.hybridComposition.calibratedActorHeight,
      player: measure(this.character),
      npcs: this.npcs.map((npc) => ({
        id: npc.id,
        roomId: npc.roomId,
        ...measure(npc.root),
      })),
    };
  },

  ensureCharacterOnWalkMask() {
    if (!this.character || !this.hybridWalkMask || this.isWorldPositionWalkable(this.character.position)) return;
    const point = this.getRoomPixelFromWorldPosition(this.character.position);
    const nearest = this.findNearestWalkableRoomPoint(point);
    const position = this.getWorldPositionFromRoomPixel(nearest);
    if (position) this.character.position.copy(position);
  },

  getRoomPlateScreenRect(canvasRect = this.renderer.domElement.getBoundingClientRect()) {
    const camera = this.currentRoom?.camera || this.rooms.placeholderRoom?.camera;
    const layerSize = camera?.userData?.layerSize || this.currentRoom?.layerSize || this.getHybridLayerSize();
    if (!camera?.isOrthographicCamera) {
      return {
        left: canvasRect.left,
        top: canvasRect.top,
        width: canvasRect.width,
        height: canvasRect.height,
      };
    }

    const orthoHeight = camera.userData.orthoHeight || layerSize.y;
    const pixelsPerWorldUnit = canvasRect.height / orthoHeight;
    const plateWidth = layerSize.x * pixelsPerWorldUnit;
    const plateHeight = layerSize.y * pixelsPerWorldUnit;
    return {
      left: canvasRect.left + (canvasRect.width - plateWidth) / 2,
      top: canvasRect.top + (canvasRect.height - plateHeight) / 2,
      width: plateWidth,
      height: plateHeight,
    };
  },

  isPointInPolygon(point, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
      const xi = polygon[i][0];
      const yi = polygon[i][1];
      const xj = polygon[j][0];
      const yj = polygon[j][1];
      const intersects = ((yi > point[1]) !== (yj > point[1]))
        && (point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi);
      if (intersects) inside = !inside;
    }
    return inside;
  },

  isPointInWalkObstacle(point, obstacles = []) {
    return obstacles.some((obstacle) => this.isPointInPolygon([point.x, point.y], obstacle.polygon || []));
  },

  getMovementBounds() {
    if (this.hybridRoomData?.hybrid3d || this.hybridWalkMask) {
      return null;
    }

    return this.hybridRoomData?.hybrid3d?.walkBounds || {
      minX: -4.1,
      maxX: 4.1,
      minZ: -4.05,
      maxZ: 4.1,
    };
  },

  updateStatus() {
    document.getElementById('room-name').textContent = this.currentRoom.name;
  },

  render() {
    if (!this.currentRoom) return;
    this.renderer.render(this.currentRoom.scene, this.currentRoom.camera);
    this.renderDebugWalkMaskOverlay();
  },

  getDebugWalkMaskOverlay() {
    if (this.debugWalkMaskOverlay) return this.debugWalkMaskOverlay;
    const overlay = document.createElement('canvas');
    overlay.style.position = 'fixed';
    overlay.style.left = '0';
    overlay.style.top = '0';
    overlay.style.width = '100vw';
    overlay.style.height = '100vh';
    overlay.style.pointerEvents = 'none';
    overlay.style.zIndex = '5';
    overlay.style.display = 'none';
    document.body.appendChild(overlay);
    this.debugWalkMaskOverlay = overlay;
    return overlay;
  },

  renderDebugWalkMaskOverlay() {
    const overlay = this.getDebugWalkMaskOverlay();
    if (!window.DEBUG_DRAW_WALKMASK || !this.hybridWalkMask) {
      overlay.style.display = 'none';
      return;
    }

    const rect = this.renderer.domElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const targetWidth = Math.max(1, Math.round(rect.width * dpr));
    const targetHeight = Math.max(1, Math.round(rect.height * dpr));
    if (overlay.width !== targetWidth || overlay.height !== targetHeight) {
      overlay.width = targetWidth;
      overlay.height = targetHeight;
    }
    overlay.style.display = 'block';
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;

    const context = overlay.getContext('2d');
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);

    const width = this.hybridRoomData?.camera?.width || 1920;
    const height = this.hybridRoomData?.camera?.height || 1080;
    const plateRect = this.getRoomPlateScreenRect(rect);
    const localPlate = {
      left: plateRect.left - rect.left,
      top: plateRect.top - rect.top,
      width: plateRect.width,
      height: plateRect.height,
    };

    context.strokeStyle = 'rgba(255,255,255,0.75)';
    context.lineWidth = 1;
    context.strokeRect(localPlate.left, localPlate.top, localPlate.width, localPlate.height);

    const bounds = this.hybridWalkMask.walkableBounds;
    if (bounds) {
      context.strokeStyle = 'rgba(0,255,120,0.95)';
      context.strokeRect(
        localPlate.left + (bounds.minX / width) * localPlate.width,
        localPlate.top + (bounds.minY / height) * localPlate.height,
        ((bounds.maxX - bounds.minX) / width) * localPlate.width,
        ((bounds.maxY - bounds.minY) / height) * localPlate.height
      );
    }

    const step = 24;
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const walkable = this.isHybridPointWalkable({ x, y });
        context.fillStyle = walkable ? 'rgba(0,255,120,0.28)' : 'rgba(255,0,0,0.18)';
        context.fillRect(
          localPlate.left + (x / width) * localPlate.width,
          localPlate.top + (y / height) * localPlate.height,
          Math.max(1, (step / width) * localPlate.width),
          Math.max(1, (step / height) * localPlate.height)
        );
      }
    }
  },

  onResize() {
    const canvas = this.renderer.domElement;
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    if (this.currentRoom?.camera) {
      this.updateCameraForViewport(this.currentRoom.camera);
    }
  },

  updateCameraForViewport(camera) {
    const aspect = window.innerWidth / window.innerHeight;
    if (camera.isOrthographicCamera) {
      const orthoHeight = camera.userData.orthoHeight || this.getHybridLayerSize().y;
      const orthoWidth = orthoHeight * aspect;
      camera.left = -orthoWidth / 2;
      camera.right = orthoWidth / 2;
      camera.top = orthoHeight / 2;
      camera.bottom = -orthoHeight / 2;
    } else {
      camera.aspect = aspect;
    }
    camera.updateProjectionMatrix();
  },
};

const InteractionEngine = {
  actionFields: [
    'text', 'repeatText', 'lockedText', 'afterText', 'giveItem', 'removeItem',
    'requiresItem', 'requiresAnyItem', 'requiresMissingItem', 'setFlag', 'setFlags',
    'requiresFlag', 'requiresFlags', 'requiresMissingFlag', 'requiresMissingFlags',
    'once', 'targetRoom', 'targetSpawn', 'raiseNoise', 'setThreat', 'spawnZombie',
    'despawnZombie', 'triggerEncounter', 'choices', 'driveSequence',
  ],

  listeners: {
    talkTo: (context = {}) => {
      const dialog = context.dialog || {
        text: `${context.displayName || 'They'} has nothing to say right now.`,
        choices: [],
      };
      const choices = (dialog.choices || []).map((choice) => ({
        label: choice.label || 'Continue',
        action: () => {
          NarratorVoice.speak(choice.text || '', [
            { label: 'Continue', action: () => { } },
          ], { voice: choice.voice });
        },
      }));
      NarratorVoice.speak(dialog.text || `${context.displayName || 'They'} has nothing to say.`, choices, { voice: dialog.voice });
    },
    inspectBox: (context = {}) => {
      NarratorVoice.speak('A dusty crate sits in the gloom. Something rattles inside. Do you investigate?', [
        {
          label: 'Inspect', action: () => {
            GameState.flags.hasInvestigatedBox = true;
            GameState.player.noiseLevel += 12;
            ThreatManager.raiseNoise(12);
            NarratorVoice.speak('You pry the lid open and hear a low shuffle from the hallway.', [
              { label: 'Continue', action: () => { } },
            ], { voice: 'crate' });
          }
        },
        {
          label: 'Leave it', action: () => {
            NarratorVoice.speak('You decide to leave it alone for now.', [
              { label: 'Continue', action: () => { } },
            ], { voice: 'leaveit' });
          }
        },
      ], { voice: 'investigatecrate' });
    },
    openDoor: (context = {}) => {
      const voice = Object.prototype.hasOwnProperty.call(context, 'voice') ? context.voice : 'dooropen';
      const enterVoice = Object.prototype.hasOwnProperty.call(context, 'enterVoice') ? context.enterVoice : 'dooropen';
      const targetRoom = context.targetRoom || context.exit?.targetRoom || 'hallway_7f';
      const targetSpawn = context.targetSpawn || context.exit?.targetSpawn || null;
      const sourceRoom = RoomManager.hybridRoomData?.id;
      NarratorVoice.speak('The door is heavy, but not locked. You can hear distant movement beyond.', [
        {
          label: 'Enter', action: () => {
            GameState.flags.doorOpened = true;
            const enteredRoom = GameState.setRoom(targetRoom, targetSpawn);
            if (!enteredRoom) {
              NarratorVoice.speak(`The way to ${targetRoom || 'the next room'} is not ready yet.`, [
                { label: 'Continue', action: () => { } },
              ]);
              return;
            }
            ThreatManager.alertRoom(GameState.currentRoom, 'alerted');
            NarratorVoice.speak('You step through into the next corridor. The shadows close in.', [
              { label: 'Continue', action: () => { } },
            ], { voice: enterVoice, voiceRoomId: sourceRoom });
          }
        },
        {
          label: 'Wait', action: () => {
            NarratorVoice.speak('You wait and listen. The house groans in silence.', [
              { label: 'Continue', action: () => { } },
            ], { voice: 'wait' });
          }
        },
      ], { voice });
    },
    pickupCrowbar: () => InteractionEngine.pickupOnce('crowbar', 'picked_crowbar', 'Romeo takes the crowbar. Heavy, ugly, persuasive.'),
    pickupScrewdriver: () => InteractionEngine.pickupOnce('screwdriver', 'picked_screwdriver', 'Romeo pockets the screwdriver. Flathead. Old handle. Useful enough.'),
    pickupFuse: () => InteractionEngine.pickupOnce('fuse', 'picked_fuse', 'Romeo takes the fuse. Small enough to lose. Important enough not to.'),
    pickupGasolineCan: () => {
      if (GameState.flags.carFueled) {
        InteractionEngine.say('The empty can has done its part.');
        return;
      }
      if (!GameState.hasItem('gasoline_can')) {
        const added = GameState.addItem('gasoline_can');
        if (!added && !GameState.hasItem('gasoline_can')) return;
      }
      GameState.startCarry('gasoline_can');
      if (!GameState.hasFlag('carryHintShown')) {
        GameState.setFlag('carryHintShown');
        InteractionEngine.say('Romeo lifts the gasoline can with both hands. It pulls his shoulders down.');
        return;
      }
      InteractionEngine.say('Romeo carries the gasoline can. Both hands busy.');
    },
    inspectCar: () => {
      GameState.setFlag('carInspected');
      if (!GameState.flags.carHoodOpen) {
        InteractionEngine.say('The car will not give him anything. The hood is bent shut, the latch buried in warped metal.');
        return;
      }
      if (!GameState.flags.carPanelOpen) {
        InteractionEngine.say('Under the hood, a small panel sits tight under four old screws.');
        return;
      }
      if (!GameState.flags.carFuseInstalled) {
        InteractionEngine.say('Inside the panel, one slot is empty. Of course it is.');
        return;
      }
      if (!GameState.flags.carFueled) {
        InteractionEngine.say('The dash gives a weak click. The tank is dry.');
        return;
      }
      if (!GameState.flags.carFixed) {
        GameState.checkCarFixed();
      }
      if (GameState.flags.carFixed) {
        InteractionEngine.say('The car is ready, if ready still means anything.');
        return;
      }
      InteractionEngine.say('The car waits under dust and bad promises.');
    },
    useCrowbarOnCar: () => {
      if (GameState.flags.carHoodOpen) {
        InteractionEngine.say('The hood is already open just enough to work.');
        return;
      }
      if (!GameState.hasItem('crowbar')) {
        InteractionEngine.say("The hood is bent shut. Fingers won't do it.");
        return;
      }
      GameState.setFlag('carHoodOpen');
      InteractionEngine.say('Metal complains. The hood opens just enough to work.');
    },
    useScrewdriverOnPanel: () => {
      if (!GameState.flags.carHoodOpen) {
        InteractionEngine.say("Can't reach the panel with the hood shut.");
        return;
      }
      if (GameState.flags.carPanelOpen) {
        InteractionEngine.say('The panel cover is already loose.');
        return;
      }
      if (!GameState.hasItem('screwdriver')) {
        InteractionEngine.say('The cover is screwed down.');
        return;
      }
      GameState.setFlag('carPanelOpen');
      InteractionEngine.say('Four screws, one shaking hand. The panel comes loose.');
    },
    interactCarFusePanel: () => {
      if (!GameState.flags.carPanelOpen) {
        InteractionEngine.listeners.useScrewdriverOnPanel();
        return;
      }
      InteractionEngine.listeners.useFuseOnFuseBox();
    },
    useFuseOnFuseBox: () => {
      if (!GameState.flags.carPanelOpen) {
        InteractionEngine.say('The fuse box is still covered.');
        return;
      }
      if (GameState.flags.carFuseInstalled) {
        InteractionEngine.say('The fuse is already seated.');
        return;
      }
      if (!GameState.hasItem('fuse')) {
        InteractionEngine.say('One empty slot. Of course.');
        return;
      }
      GameState.removeItem('fuse');
      GameState.setFlag('carFuseInstalled');
      const completed = GameState.checkCarFixed();
      InteractionEngine.say(completed
        ? 'The fuse clicks into place. Something under the dash remembers electricity. The engine coughs once. Then again. Alive, barely.'
        : 'The fuse clicks into place. Something under the dash remembers electricity.');
    },
    useGasolineOnCar: () => {
      if (GameState.flags.carFueled) {
        InteractionEngine.say('The tank has enough. For now.');
        return;
      }
      if (GameState.player.carryingItem?.id !== 'gasoline_can') {
        InteractionEngine.say('The tank is empty. Whatever fuel was here is gone.');
        return;
      }
      GameState.setFlag('carFueled');
      GameState.stopCarry();
      GameState.removeItem('gasoline_can');
      const completed = GameState.checkCarFixed();
      InteractionEngine.say(completed
        ? 'The car drinks it like a dying man at a fountain. The engine coughs once. Then again. Alive, barely.'
        : 'The car drinks it like a dying man at a fountain.');
    },
    tryStartCar: () => {
      if (GameState.checkCarFixed() || GameState.flags.carFixed) {
        InteractionEngine.say('The engine coughs once. Then again. Alive, barely.');
        return;
      }
      InteractionEngine.listeners.inspectCar();
    },
    blockedAimWhileCarrying: () => {
      InteractionEngine.say('Not with both hands full.');
    },
  },

  pickupOnce(itemId, flagId, text) {
    if (GameState.hasFlag(flagId) || GameState.hasItem(itemId)) {
      this.say('Nothing useful left there.');
      return;
    }
    if (GameState.addItem(itemId)) {
      GameState.setFlag(flagId);
      this.say(text);
    }
  },

  hasActionFields(action) {
    return Boolean(action && typeof action === 'object' && this.actionFields.some((field) => Object.prototype.hasOwnProperty.call(action, field)));
  },

  process(interactionId, context = {}) {
    if (Object.prototype.hasOwnProperty.call(context, 'anim')) {
      RoomManager.playInteractionAnimation(context.anim);
    }
    if (interactionId && typeof interactionId === 'object') {
      this.runAction(interactionId, context);
      return;
    }
    const listener = this.listeners[interactionId];
    if (listener) {
      listener(context);
      return;
    }
    if (this.hasActionFields(context)) {
      this.runAction(context, context);
    }
  },

  runRoomEnter(roomData = null) {
    const scripts = Array.isArray(roomData?.onEnter) ? roomData.onEnter : [];
    for (const script of scripts) {
      if (script.once && GameState.hasFlag(`once.${script.once}`)) continue;
      if (!this.requirementsMet(script, { silent: true })) continue;
      this.runAction(script, { roomData, source: 'onEnter', ambient: true });
      break;
    }
  },

  requirementsMet(action, { silent = false } = {}) {
    const hasAll = (ids = []) => ids.every((id) => GameState.hasFlag(id));
    const missingAll = (ids = []) => ids.every((id) => !GameState.hasFlag(id));
    const blocked = [];
    if (action.requiresItem && !GameState.hasItem(action.requiresItem)) blocked.push('item');
    if (Array.isArray(action.requiresAnyItem) && !action.requiresAnyItem.some((id) => GameState.hasItem(id))) blocked.push('any item');
    if (action.requiresMissingItem && GameState.hasItem(action.requiresMissingItem)) blocked.push('missing item');
    if (action.requiresFlag && !GameState.hasFlag(action.requiresFlag)) blocked.push('flag');
    if (Array.isArray(action.requiresFlags) && !hasAll(action.requiresFlags)) blocked.push('flags');
    if (action.requiresMissingFlag && GameState.hasFlag(action.requiresMissingFlag)) blocked.push('missing flag');
    if (Array.isArray(action.requiresMissingFlags) && !missingAll(action.requiresMissingFlags)) blocked.push('missing flags');
    if (!blocked.length) return true;
    if (!silent) {
      this.say(action.lockedText || 'It will not open. Not yet.', action);
    }
    return false;
  },

  runAction(action, context = {}) {
    if (!action || typeof action !== 'object') return false;
    if (Object.prototype.hasOwnProperty.call(context, 'anim')) {
      RoomManager.playInteractionAnimation(context.anim);
    }
    if (!this.requirementsMet(action)) return false;

    const onceFlag = action.once ? `once.${action.once}` : null;
    if (onceFlag && GameState.hasFlag(onceFlag)) {
      this.say(action.repeatText || 'Nothing else here.', action);
      return false;
    }

    if (Array.isArray(action.choices) && action.choices.length) {
      const choices = action.choices.map((choice) => ({
        label: choice.label || 'Continue',
        action: () => this.runAction(choice.action || choice, context),
      }));
      this.say(action.text || context.text || 'Romeo waits.', action, choices);
      return true;
    }

    if (action.once) GameState.setFlag(onceFlag, true);
    if (action.setFlag) GameState.setFlag(action.setFlag);
    if (Array.isArray(action.setFlags)) action.setFlags.forEach((flagId) => GameState.setFlag(flagId));
    if (action.removeItem) GameState.removeItem(action.removeItem);
    if (action.giveItem) GameState.addItem(action.giveItem);
    if (Number.isFinite(action.raiseNoise)) {
      GameState.player.noiseLevel += action.raiseNoise;
      ThreatManager.raiseNoise(action.raiseNoise);
    }
    if (action.setThreat) ThreatManager.alertRoom(GameState.currentRoom, action.setThreat);
    if (action.spawnZombie) RoomManager.setActorActive(action.spawnZombie, true);
    if (action.despawnZombie) RoomManager.setActorActive(action.despawnZombie, false);
    if (action.triggerEncounter) {
      GameState.setFlag(`encounter.${action.triggerEncounter}`);
      ThreatManager.alertRoom(GameState.currentRoom, 'danger');
    }

    if (action.driveSequence) {
      RoomManager.playDriveSequence(action.driveSequence, action);
      return true;
    }

    const targetRoom = action.targetRoom || context.targetRoom || context.exit?.targetRoom;
    const targetSpawn = action.targetSpawn || context.targetSpawn || context.exit?.targetSpawn || null;
    if (targetRoom) {
      const sourceRoom = RoomManager.hybridRoomData?.id;
      const moved = GameState.setRoom(targetRoom, targetSpawn);
      if (!moved) {
        this.say(`The way to ${targetRoom} is not ready yet.`, action);
        return false;
      }
      if (action.afterText) this.say(action.afterText, { ...action, voiceRoomId: sourceRoom }, null, { ambient: true });
      else if (action.text) this.say(action.text, { ...action, voiceRoomId: sourceRoom }, null, { ambient: true });
      return true;
    }

    this.say(action.text || context.text || 'Nothing else here.', action, null, { ambient: context.ambient });
    return true;
  },

  say(text, action = {}, choices = null, options = {}) {
    if (options.ambient) {
      NarratorVoice.setAmbientText(text);
      return;
    }
    NarratorVoice.speak(
      text,
      choices || [{ label: 'Continue', action: () => { } }],
      { voice: action.voice, voiceRoomId: action.voiceRoomId }
    );
  },
};

const InventorySystem = {
  maxSlots: 8,
  init() {
    this.container = document.getElementById('inventory-grid');
    this.refresh();
  },

  refresh() {
    if (!this.container) return;
    this.container.innerHTML = '';
    for (let index = 0; index < this.maxSlots; index++) {
      const slot = document.createElement('div');
      slot.className = 'inventory-slot';
      const item = GameState.player.inventory[index];
      if (item) {
        slot.textContent = item.icon ? `${item.icon} ${item.name}` : item.name;
        slot.title = item.description;
      } else {
        slot.textContent = '';
      }
      this.container.appendChild(slot);
    }
  },
};

const NarratorVoice = {
  textElement: null,
  choiceContainer: null,
  typeTimer: null,
  audio: null,
  voiceTimer: null,
  voiceAttemptTimer: null,
  pendingVoiceId: null,
  pendingVoiceOptions: null,
  pendingChoices: null,
  voiceExtensions: ['wav', 'mp3', 'ogg'],

  init() {
    this.textElement = document.getElementById('narrator-text');
    this.choiceContainer = document.getElementById('choice-buttons');
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.volume = 0.92;
    window.NarratorVoice = this;
    window.addEventListener('pointerdown', () => this.retryPendingVoice(), { passive: true });
    window.addEventListener('keydown', () => this.retryPendingVoice(), { passive: true });
    this.speak('Welcome to the PSX zombie text adventure skeleton. Click the crate or the door to test the interaction flow.', [
      { label: 'Begin', action: () => { } },
    ], //{ voice: 'welcome' } 
    );
  },

  speak(message, choices = [], options = {}) {
    this.clear({ stopVoice: true });
    this.playVoice(options.voice, options);
    this.pendingChoices = choices;
    this.renderChoices(choices, { disabled: true });
    let index = 0;
    const speed = 30;
    const typeCharacter = () => {
      if (index <= message.length) {
        this.textElement.textContent = message.slice(0, index);
        index += 1;
        this.typeTimer = window.setTimeout(typeCharacter, speed);
      } else {
        this.typeTimer = null;
        this.renderPendingChoicesWhenReady();
      }
    };
    typeCharacter();
  },

  setInstantText(message) {
    if (this.isBusy()) return;
    this.clear({ stopVoice: false });
    if (this.textElement) this.textElement.textContent = message;
  },

  setAmbientText(message) {
    if (!message) return;
    this.clear({ stopVoice: false });
    if (this.textElement) this.textElement.textContent = message;
  },

  getVoicePath(voiceId, extension, roomId = RoomManager.hybridRoomData?.id) {
    if (!roomId || !voiceId) return null;
    const roomData = RoomManager.roomDataById?.[roomId] || RoomManager.hybridRoomData;
    return RoomManager.getRoomAssetPath(roomData, `rooms/${roomId}/voice/${voiceId}.${extension}`);
  },

  playVoice(voiceId, options = {}) {
    if (!voiceId || !this.audio) return;
    this.pendingVoiceId = voiceId;
    this.pendingVoiceOptions = options;
    this.tryVoiceExtension(voiceId, 0, options);
  },

  tryVoiceExtension(voiceId, extensionIndex, options = {}) {
    if (!this.audio || this.pendingVoiceId !== voiceId) return;
    if (extensionIndex >= this.voiceExtensions.length) {
      if (this.voiceAttemptTimer) {
        window.clearTimeout(this.voiceAttemptTimer);
        this.voiceAttemptTimer = null;
      }
      this.pendingVoiceId = null;
      this.pendingVoiceOptions = null;
      this.renderPendingChoicesWhenReady();
      return;
    }

    const src = this.getVoicePath(voiceId, this.voiceExtensions[extensionIndex], options.voiceRoomId);
    if (!src) {
      this.tryVoiceExtension(voiceId, extensionIndex + 1, options);
      return;
    }
    this.audio.pause();
    this.audio.currentTime = 0;
    this.audio.src = src;
    if (this.voiceAttemptTimer) window.clearTimeout(this.voiceAttemptTimer);
    this.audio.onerror = () => this.tryVoiceExtension(voiceId, extensionIndex + 1, options);
    this.audio.onended = () => this.renderPendingChoicesWhenReady();
    this.voiceAttemptTimer = window.setTimeout(() => {
      if (this.pendingVoiceId !== voiceId) return;
      if (this.audio.readyState === HTMLMediaElement.HAVE_NOTHING || this.audio.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) {
        this.tryVoiceExtension(voiceId, extensionIndex + 1, options);
      }
    }, 1200);
    const playPromise = this.audio.play();
    if (playPromise?.catch) {
      playPromise
        .then(() => {
          if (this.voiceAttemptTimer) {
            window.clearTimeout(this.voiceAttemptTimer);
            this.voiceAttemptTimer = null;
          }
          if (this.pendingVoiceId === voiceId) {
            this.pendingVoiceId = null;
            this.pendingVoiceOptions = null;
          }
        })
        .catch(() => {
          this.pendingVoiceId = voiceId;
        });
    }
  },

  retryPendingVoice() {
    if (!this.pendingVoiceId || !this.audio?.paused) return;
    const voiceId = this.pendingVoiceId;
    const options = this.pendingVoiceOptions || {};
    this.voiceTimer = window.setTimeout(() => this.tryVoiceExtension(voiceId, 0, options), 0);
  },

  renderChoices(choices, { disabled = false } = {}) {
    this.choiceContainer.innerHTML = '';
    choices.forEach((choice) => {
      const button = document.createElement('button');
      button.className = 'choice-button';
      button.textContent = choice.label;
      button.disabled = disabled;
      button.onclick = () => {
        if (button.disabled) return;
        this.clear({ stopVoice: true });
        if (choice.action) choice.action();
      };
      this.choiceContainer.appendChild(button);
    });
  },

  renderPendingChoicesWhenReady() {
    if (this.typeTimer || !this.pendingChoices) return;
    if (this.isVoicePlaying()) {
      this.audio.onended = () => this.renderPendingChoicesWhenReady();
      return;
    }
    const choices = this.pendingChoices;
    this.pendingChoices = null;
    this.renderChoices(choices, { disabled: false });
  },

  isVoicePlaying() {
    return Boolean(this.audio
      && !this.audio.paused
      && !this.audio.ended
      && this.audio.readyState > HTMLMediaElement.HAVE_NOTHING
      && this.audio.networkState !== HTMLMediaElement.NETWORK_NO_SOURCE);
  },

  isBusy() {
    return Boolean(this.typeTimer)
      || Boolean(this.pendingChoices)
      || this.isVoicePlaying()
      || Boolean(this.choiceContainer?.children.length);
  },

  clear({ stopVoice = true } = {}) {
    if (this.typeTimer) {
      window.clearTimeout(this.typeTimer);
      this.typeTimer = null;
    }
    if (this.voiceTimer) {
      window.clearTimeout(this.voiceTimer);
      this.voiceTimer = null;
    }
    if (this.voiceAttemptTimer) {
      window.clearTimeout(this.voiceAttemptTimer);
      this.voiceAttemptTimer = null;
    }
    if (stopVoice && this.audio) {
      this.pendingVoiceId = null;
      this.pendingVoiceOptions = null;
      this.audio.pause();
      this.audio.currentTime = 0;
      this.audio.onerror = null;
      this.audio.onended = null;
    }
    this.pendingChoices = null;
    if (this.textElement) this.textElement.textContent = '';
    if (this.choiceContainer) this.choiceContainer.innerHTML = '';
  },
};

const ThreatManager = {
  roomThreats: {},
  noise: 0,

  init() {
    this.setRoomState('placeholderRoom', 'dormant');
    this.updateUI();
  },

  setRoomState(roomId, state) {
    this.roomThreats[roomId] = state;
    if (GameState.currentRoom === roomId) {
      document.getElementById('threat-state').textContent = state;
    }
  },

  raiseNoise(amount) {
    this.noise += amount;
    this.noise = Math.min(this.noise, 100);
    document.getElementById('noise-meter').textContent = this.noise;
    if (this.noise > 40) {
      this.setRoomState(GameState.currentRoom, 'alerted');
    }
  },

  alertRoom(roomId, state = 'alerted') {
    this.setRoomState(roomId, state);
  },

  update(delta) {
    if (this.noise > 0) {
      this.noise = Math.max(this.noise - delta * 3, 0);
      document.getElementById('noise-meter').textContent = Math.round(this.noise);
    }
  },

  updateUI() {
    document.getElementById('threat-state').textContent = this.roomThreats[GameState.currentRoom] || 'dormant';
    document.getElementById('noise-meter').textContent = this.noise;
  },
};

const AudioManager = {
  audio: null,
  currentSrc: null,
  pendingPlay: false,
  musicSrc: './rooms/Cassette_in_Room9.mp3',
  volume: 0.42,
  lastError: null,
  hasUserGesture: false,

  init() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.loop = true;
    this.audio.volume = this.volume;
    this.audio.onerror = () => {
      this.lastError = this.audio?.error?.message || `Media error ${this.audio?.error?.code || 'unknown'}`;
      console.warn('Music failed to load.', this.lastError);
    };
    window.DEBUG_AUDIO = () => this.getDebugState();
    const unlockOptions = { passive: true, capture: true };
    window.addEventListener('pointerdown', () => this.unlockMusic(), unlockOptions);
    window.addEventListener('click', () => this.unlockMusic(), unlockOptions);
    window.addEventListener('touchstart', () => this.unlockMusic(), unlockOptions);
    window.addEventListener('keydown', () => this.unlockMusic(), unlockOptions);
    window.addEventListener('gamepadconnected', () => this.unlockMusic(), unlockOptions);
    this.prepareMusic();
  },

  playForRoom(room) {
    if (this.hasUserGesture) this.playMusic();
  },

  prepareMusic() {
    if (!this.audio || !this.musicSrc) return;
    const src = this.musicSrc;
    this.audio.loop = true;
    this.audio.volume = this.volume;
    if (this.currentSrc !== src) {
      this.currentSrc = src;
      this.audio.src = src;
      this.audio.currentTime = 0;
      this.audio.load();
    }
  },

  playMusic() {
    this.prepareMusic();
    this.play();
  },

  play() {
    if (!this.audio || !this.currentSrc) return;
    this.lastError = null;
    const playPromise = this.audio.play();
    if (playPromise?.catch) {
      playPromise
        .then(() => {
          this.pendingPlay = false;
        })
        .catch(() => {
          this.pendingPlay = true;
        });
    }
  },

  unlockMusic() {
    this.hasUserGesture = true;
    this.playMusic();
  },

  retryPendingMusic() {
    this.unlockMusic();
  },

  stop() {
    if (!this.audio) return;
    this.pendingPlay = false;
    this.currentSrc = null;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
  },

  getDebugState() {
    return {
      src: this.currentSrc,
      paused: this.audio?.paused ?? true,
      pendingPlay: this.pendingPlay,
      hasUserGesture: this.hasUserGesture,
      volume: this.audio?.volume ?? 0,
      loop: this.audio?.loop ?? false,
      currentTime: this.audio?.currentTime ?? 0,
      readyState: this.audio?.readyState ?? 0,
      networkState: this.audio?.networkState ?? 0,
      error: this.lastError,
    };
  },
};

const CombatSystem = {
  debugLaser: true,
  traceDamage: 1,
  traceRange: 8,
  hitRadius: 0.42,
  lastTrace: null,
  laserLine: null,
  laserTimer: null,

  init() {
    window.DEBUG_SHOOT_LASER = this.debugLaser;
    window.SET_DEBUG_SHOOT_LASER = (enabled = true) => {
      this.debugLaser = Boolean(enabled);
      window.DEBUG_SHOOT_LASER = this.debugLaser;
      if (!this.debugLaser) this.clearLaser();
      return this.debugLaser;
    };
    window.DEBUG_TRACE_SHOT = () => this.lastTrace;
  },

  traceShotFromPointer(event) {
    const character = RoomManager.character;
    if (!character || !RoomManager.currentRoom?.scene) return null;
    if (GameState.isCarryingTwoHanded()) {
      InteractionEngine.process('blockedAimWhileCarrying');
      return null;
    }

    const target = RoomManager.getWorldPositionFromRoomPixel(RoomManager.getRoomPixelFromPointer(event));
    const muzzleOrigin = RoomManager.getWeaponMuzzleWorldPosition();
    const origin = muzzleOrigin || character.position.clone();
    if (!muzzleOrigin) origin.y += 1.1 * (character.scale?.y || 1);

    const pickedHit = this.pickZombieFromPointer(event, origin);
    const fallbackDirection = this.getFallbackShotDirection(event, origin, target);
    const end = pickedHit?.point || origin.clone().addScaledVector(fallbackDirection, this.traceRange);
    const hit = pickedHit || this.findZombieHit(origin, end);
    const finalEnd = hit?.point || end;
    this.lastTrace = {
      roomId: RoomManager.hybridRoomData?.id,
      origin: { x: origin.x, y: origin.y, z: origin.z },
      end: { x: finalEnd.x, y: finalEnd.y, z: finalEnd.z },
      activeZombies: RoomManager.getActiveNPCs().filter((npc) => npc.actorType === 'zombie').length,
      picked: Boolean(pickedHit),
      hit: hit ? { id: hit.npc.id, distance: hit.distance } : null,
    };

    if (window.DEBUG_SHOOT_LASER ?? this.debugLaser) this.drawLaser(origin, finalEnd, Boolean(hit));
    if (hit) this.applyTraceHit(hit.npc);
    else if (!NarratorVoice.isBusy()) NarratorVoice.setAmbientText('The shot line finds only rain.');
    return this.lastTrace;
  },

  getFallbackShotDirection(event, origin, target) {
    const character = RoomManager.character;
    const ray = this.getPointerRay(event);
    const fallback = ray?.direction?.clone()
      || new THREE.Vector3(0, 0, -1).applyQuaternion(character.quaternion);
    const direction = target
      ? target.clone().sub(origin)
      : fallback;
    if (direction.lengthSq() < 0.0001) direction.copy(fallback);
    direction.normalize();
    return direction;
  },

  getPointerRay(event) {
    const camera = RoomManager.currentRoom?.camera;
    const canvas = RoomManager.renderer?.domElement;
    if (!camera || !canvas || !event) return null;
    const rect = canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, camera);
    return raycaster.ray.clone();
  },

  pickZombieFromPointer(event, origin) {
    const zombies = RoomManager.getActiveNPCs()
      .filter((npc) => npc.actorType === 'zombie' && npc.root?.visible !== false);
    if (!zombies.length) return null;

    const ray = this.getPointerRay(event);
    if (ray) {
      const raycaster = new THREE.Raycaster(ray.origin, ray.direction, 0, 100);
      const roots = zombies.map((npc) => npc.root).filter(Boolean);
      const hits = raycaster.intersectObjects(roots, true);
      for (const hit of hits) {
        const npc = zombies.find((candidate) => candidate.root === hit.object || candidate.root.children.includes(hit.object) || this.isDescendantOf(hit.object, candidate.root));
        if (!npc) continue;
        return {
          npc,
          point: hit.point.clone(),
          distance: origin.distanceTo(hit.point),
          missDistance: 0,
          picked: true,
        };
      }
    }

    return this.pickZombieByScreenDistance(event, origin, zombies);
  },

  isDescendantOf(object, root) {
    let current = object;
    while (current) {
      if (current === root) return true;
      current = current.parent;
    }
    return false;
  },

  pickZombieByScreenDistance(event, origin, zombies) {
    const camera = RoomManager.currentRoom?.camera;
    const canvas = RoomManager.renderer?.domElement;
    if (!camera || !canvas || !event) return null;
    const rect = canvas.getBoundingClientRect();
    let best = null;

    zombies.forEach((npc) => {
      const center = this.getNPCTraceCenter(npc);
      if (!center) return;
      const projected = center.clone().project(camera);
      if (projected.z < -1 || projected.z > 1) return;
      const sx = rect.left + ((projected.x + 1) * 0.5 * rect.width);
      const sy = rect.top + ((1 - projected.y) * 0.5 * rect.height);
      const distancePx = Math.hypot(event.clientX - sx, event.clientY - sy);
      const radiusPx = Number.isFinite(npc.screenTraceRadiusPx) ? npc.screenTraceRadiusPx : 54;
      if (distancePx > radiusPx) return;
      const worldDistance = origin.distanceTo(center);
      if (!best || distancePx < best.distancePx) {
        best = {
          npc,
          point: center,
          distance: worldDistance,
          missDistance: distancePx,
          distancePx,
          picked: true,
        };
      }
    });

    return best;
  },

  getNPCTraceCenter(npc) {
    if (!npc?.root) return null;
    const box = new THREE.Box3().setFromObject(npc.root);
    if (!Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) {
      return npc.root.position.clone().add(new THREE.Vector3(0, 0.9, 0));
    }
    const center = new THREE.Vector3();
    box.getCenter(center);
    center.y = THREE.MathUtils.lerp(box.min.y, box.max.y, 0.58);
    return center;
  },

  findZombieHit(origin, end) {
    const segment = end.clone().sub(origin);
    const lengthSq = segment.lengthSq();
    if (lengthSq <= 0.0001) return null;
    let best = null;
    RoomManager.getActiveNPCs()
      .filter((npc) => npc.actorType === 'zombie' && npc.root?.visible !== false)
      .forEach((npc) => {
        const center = this.getNPCTraceCenter(npc) || npc.root.position.clone();
        const t = THREE.MathUtils.clamp(center.clone().sub(origin).dot(segment) / lengthSq, 0, 1);
        const point = origin.clone().addScaledVector(segment, t);
        const distance = center.distanceTo(point);
        const radius = Number.isFinite(npc.traceRadius)
          ? npc.traceRadius
          : Math.max(this.hitRadius, (npc.collisionRadius || 0.34) + 0.12);
        if (distance > radius) return;
        const along = origin.distanceTo(point);
        if (!best || along < best.distance) best = { npc, point, distance: along, missDistance: distance };
      });
    return best;
  },

  applyTraceHit(npc) {
    npc.health = Math.max(0, (npc.health ?? 1) - this.traceDamage);
    ThreatManager.alertRoom(GameState.currentRoom, 'danger');
    if (npc.health <= 0) {
      npc.active = false;
      if (npc.root) npc.root.visible = false;
      if (!NarratorVoice.isBusy()) NarratorVoice.setAmbientText('The trace drops the dead thing.');
      return;
    }
    if (!NarratorVoice.isBusy()) NarratorVoice.setAmbientText('The trace catches dead meat.');
  },

  drawLaser(origin, end, hit = false) {
    this.clearLaser();
    const geometry = new THREE.BufferGeometry().setFromPoints([origin, end]);
    const material = new THREE.LineBasicMaterial({
      color: hit ? 0xff2020 : 0xff0000,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
    });
    this.laserLine = new THREE.Line(geometry, material);
    this.laserLine.renderOrder = 999;
    RoomManager.currentRoom?.scene?.add(this.laserLine);
    this.laserTimer = window.setTimeout(() => this.clearLaser(), 140);
  },

  clearLaser() {
    if (this.laserTimer) {
      window.clearTimeout(this.laserTimer);
      this.laserTimer = null;
    }
    if (!this.laserLine) return;
    this.laserLine.removeFromParent();
    this.laserLine.geometry?.dispose?.();
    this.laserLine.material?.dispose?.();
    this.laserLine = null;
  },
};

const App = {
  lastTime: 0,
  movement: null,

  async init() {
    const canvas = document.getElementById('render-canvas');
    InventorySystem.init();
    NarratorVoice.init();
    ThreatManager.init();
    AudioManager.init();
    CombatSystem.init();
    GameState.updatePlayerHealthUI();
    await RoomManager.init(canvas);
    this.movement = new TankMovementController({
      getCharacter: () => RoomManager.character,
      walkSpeed: RoomManager.characterSpeed,
      turnSpeed: RoomManager.characterTurnSpeed,
      bounds: RoomManager.hybridRoomData?.hybrid3d ? null : RoomManager.getMovementBounds(),
      getGroundY: (position) => RoomManager.getWalkSurfaceYAt(position),
      canMoveTo: (position, fromPosition) => RoomManager.canMoveToWorldPosition(position, fromPosition),
      isCarryMode: () => GameState.isCarryingTwoHanded(),
      onBlockedAim: () => InteractionEngine.process('blockedAimWhileCarrying'),
    });
    window.DEBUG_MOVE = () => ({
      controllerBounds: this.movement?.bounds,
      hasWalkMask: Boolean(RoomManager.hybridWalkMask),
      walkMaskMode: RoomManager.hybridWalkMask?.mode,
      walkableBounds: RoomManager.hybridWalkMask?.walkableBounds,
      characterWorld: RoomManager.character ? {
        x: RoomManager.character.position.x,
        y: RoomManager.character.position.y,
        z: RoomManager.character.position.z,
      } : null,
      characterPixel: RoomManager.character
        ? RoomManager.getRoomPixelFromWorldPosition(RoomManager.character.position)
        : null,
      characterWalkable: RoomManager.character
        ? RoomManager.isWorldPositionWalkable(RoomManager.character.position)
        : null,
    });
    window.DEBUG_GAMEPAD = () => this.movement?.getGamepadDebugState?.() || null;
    this.movement.attach();

    canvas.addEventListener('click', (event) => {
      const leftClick = event.button === 0;
      const aiming = event.ctrlKey || this.movement?.isAimPressed?.() || this.movement?.state === 'aim';
      if (leftClick && aiming) {
        event.preventDefault();
        CombatSystem.traceShotFromPointer(event);
        return;
      }
      if (NarratorVoice.isBusy()) {
        this.movement?.clearTarget();
        return;
      }
      const pathOptions = event.detail >= 2 ? { speedMultiplier: 1.75 } : {};
      const queueArrival = (path, onArrive) => this.movement?.setPath(path, onArrive, pathOptions);
      const handledInteraction = RoomManager.handleClick(event, queueArrival);
      if (handledInteraction) {
        return;
      }

      const path = RoomManager.getWalkPathFromPointer(event);
      if (path?.length) {
        this.movement.setPath(path, null, pathOptions);
      } else if (RoomManager.hybridRoomData?.hybrid3d) {
        NarratorVoice.setAmbientText('Romeo studies the route. No.');
      }
    });
    canvas.addEventListener('mousemove', (event) => {
      RoomManager.setHeadLookFromPointer(event);
      RoomManager.handlePointerHover(event);
    });

    this.lastTime = performance.now();
    this.loop(this.lastTime);
  },

  loop(time) {
    const delta = (time - this.lastTime) / 1000;
    this.lastTime = time;
    RoomManager.ensureCharacterOnWalkMask();
    if (this.movement) {
      this.movement.enabled = !RoomManager.isPlayerBusy();
      if (!this.movement.enabled) this.movement.clearTarget();
    }
    const movementState = this.movement?.update(delta) || 'idle';
    if (this.movement?.consumeGamepadActivate?.()) {
      AudioManager.unlockMusic();
      RoomManager.handleGamepadActivate((path, onArrive) => this.movement?.setPath(path, onArrive));
    }
    RoomManager.update(delta, movementState);
    ThreatManager.update(delta);
    RoomManager.render();
    requestAnimationFrame((timestamp) => this.loop(timestamp));
  },
};

window.GameState = GameState;
window.RoomManager = RoomManager;
window.InteractionEngine = InteractionEngine;
window.CombatSystem = CombatSystem;
window.App = App;
window.addEventListener('DOMContentLoaded', () => App.init());
