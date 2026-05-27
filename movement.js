import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.152.2/build/three.module.js';

export class TankMovementController {
  constructor({
    getCharacter,
    walkSpeed = 1.8,
    backpedalSpeed = 1.15,
    carryWalkSpeed = 0.95,
    carryBackpedalSpeed = 0.65,
    turnSpeed = Math.PI * 1.7,
    arrivalDistance = 0.12,
    targetTurnSharpness = 10,
    maxStepDistance = 0.035,
    bounds = {
      minX: -4.1,
      maxX: 4.1,
      minZ: -4.05,
      maxZ: 4.1,
    },
    canMoveTo = null,
    getGroundY = () => 0,
    isCarryMode = () => false,
    onBlockedAim = null,
  }) {
    this.getCharacter = getCharacter;
    this.walkSpeed = walkSpeed;
    this.backpedalSpeed = backpedalSpeed;
    this.carryWalkSpeed = carryWalkSpeed;
    this.carryBackpedalSpeed = carryBackpedalSpeed;
    this.turnSpeed = turnSpeed;
    this.bounds = bounds;
    this.canMoveTo = canMoveTo;
    this.getGroundY = getGroundY;
    this.isCarryMode = isCarryMode;
    this.onBlockedAim = onBlockedAim;
    this.arrivalDistance = arrivalDistance;
    this.targetTurnSharpness = targetTurnSharpness;
    this.maxStepDistance = maxStepDistance;
    this.targetPosition = null;
    this.path = [];
    this.onPathComplete = null;
    this.pathSpeedMultiplier = 1;
    this.keys = {};
    this.gamepad = {
      index: null,
      connected: false,
      id: null,
      leftX: 0,
      leftY: 0,
      aiming: false,
      forward: false,
      backward: false,
      turnLeft: false,
      turnRight: false,
      activatePressed: false,
      previousActivatePressed: false,
      activateQueued: false,
    };
    this.gamepadDeadzone = 0.25;
    this.state = 'idle';
    this.forward = new THREE.Vector3();
    this.toTarget = new THREE.Vector3();
    this.candidatePosition = new THREE.Vector3();
    this.enabled = true;
    this.blockedAimActive = false;
  }

  getGroundYFor(position = null) {
    return this.getGroundY ? this.getGroundY(position) : 0;
  }

  attach() {
    window.addEventListener('keydown', (event) => this.handleKey(event, true));
    window.addEventListener('keyup', (event) => this.handleKey(event, false));
    window.addEventListener('gamepadconnected', (event) => this.connectGamepad(event.gamepad));
    window.addEventListener('gamepaddisconnected', (event) => this.disconnectGamepad(event.gamepad));
  }

  handleKey(event, isPressed) {
    if (!this.isMovementKey(event.code)) return;
    event.preventDefault();
    this.keys[event.code] = isPressed;
  }

  isMovementKey(code) {
    return [
      'ControlLeft',
      'ControlRight',
      'KeyW',
      'KeyA',
      'KeyS',
      'KeyD',
      'ArrowUp',
      'ArrowLeft',
      'ArrowDown',
      'ArrowRight',
    ].includes(code);
  }

  connectGamepad(gamepad) {
    if (this.gamepad.index !== null && this.gamepad.connected) return;
    this.gamepad.index = gamepad.index;
    this.gamepad.connected = true;
    this.gamepad.id = gamepad.id;
  }

  disconnectGamepad(gamepad) {
    if (this.gamepad.index !== gamepad.index) return;
    this.gamepad.index = null;
    this.gamepad.connected = false;
    this.gamepad.id = null;
    this.gamepad.leftX = 0;
    this.gamepad.leftY = 0;
    this.gamepad.aiming = false;
    this.gamepad.forward = false;
    this.gamepad.backward = false;
    this.gamepad.turnLeft = false;
    this.gamepad.turnRight = false;
    this.gamepad.activatePressed = false;
    this.gamepad.previousActivatePressed = false;
    this.gamepad.activateQueued = false;
  }

  findGamepad() {
    const pads = navigator.getGamepads?.() || [];
    if (this.gamepad.index !== null && pads[this.gamepad.index]) return pads[this.gamepad.index];
    return [...pads].find((pad) => pad && (pad.mapping === 'standard' || /xinput|xbox/i.test(pad.id)))
      || [...pads].find(Boolean)
      || null;
  }

  updateGamepadState() {
    const pad = this.findGamepad();
    if (!pad) {
      if (this.gamepad.connected) this.disconnectGamepad({ index: this.gamepad.index });
      return;
    }

    if (this.gamepad.index !== pad.index) this.connectGamepad(pad);

    const buttonDown = (index) => Boolean(pad.buttons?.[index]?.pressed || pad.buttons?.[index]?.value > 0.5);
    const axis = (index) => {
      const value = pad.axes?.[index] || 0;
      return Math.abs(value) >= this.gamepadDeadzone ? value : 0;
    };

    this.gamepad.leftX = axis(0);
    this.gamepad.leftY = axis(1);
    this.gamepad.turnLeft = this.gamepad.leftX < -this.gamepadDeadzone || buttonDown(14);
    this.gamepad.turnRight = this.gamepad.leftX > this.gamepadDeadzone || buttonDown(15);
    this.gamepad.forward = this.gamepad.leftY < -this.gamepadDeadzone || buttonDown(12);
    this.gamepad.backward = this.gamepad.leftY > this.gamepadDeadzone || buttonDown(13);
    this.gamepad.aiming = buttonDown(6) || buttonDown(4);

    this.gamepad.previousActivatePressed = this.gamepad.activatePressed;
    this.gamepad.activatePressed = buttonDown(0);
    if (this.gamepad.activatePressed && !this.gamepad.previousActivatePressed) {
      this.gamepad.activateQueued = true;
    }
  }

  consumeGamepadActivate() {
    const queued = this.gamepad.activateQueued;
    this.gamepad.activateQueued = false;
    return queued;
  }

  getGamepadDebugState() {
    return {
      index: this.gamepad.index,
      connected: this.gamepad.connected,
      id: this.gamepad.id,
      leftX: this.gamepad.leftX,
      leftY: this.gamepad.leftY,
      aiming: this.gamepad.aiming,
      forward: this.gamepad.forward,
      backward: this.gamepad.backward,
      turnLeft: this.gamepad.turnLeft,
      turnRight: this.gamepad.turnRight,
    };
  }

  isAimPressed() {
    return Boolean(this.keys.ControlLeft || this.keys.ControlRight || this.gamepad.aiming);
  }

  setTarget(position) {
    this.setPath(position ? [position] : []);
  }

  setPath(worldPoints = [], onComplete = null, options = {}) {
    this.path = (worldPoints || [])
      .filter(Boolean)
      .map((point) => {
        const waypoint = point.clone ? point.clone() : new THREE.Vector3(point.x, point.y || 0, point.z);
        waypoint.y = this.getGroundYFor(waypoint);
        return waypoint;
      });
    this.targetPosition = this.path[0] || null;
    this.onPathComplete = onComplete;
    this.pathSpeedMultiplier = Number.isFinite(options.speedMultiplier) ? Math.max(0.1, options.speedMultiplier) : 1;
  }

  clearTarget() {
    this.targetPosition = null;
    this.path = [];
    this.onPathComplete = null;
    this.pathSpeedMultiplier = 1;
  }

  update(delta) {
    if (!this.enabled) {
      this.state = 'idle';
      return this.state;
    }

    const character = this.getCharacter();
    if (!character) {
      this.state = 'idle';
      return this.state;
    }

    this.updateGamepadState();

    const aiming = this.keys.ControlLeft || this.keys.ControlRight || this.gamepad.aiming;
    const turningLeft = this.keys.KeyA || this.keys.ArrowLeft || this.gamepad.turnLeft;
    const turningRight = this.keys.KeyD || this.keys.ArrowRight || this.gamepad.turnRight;
    const movingForward = this.keys.KeyW || this.keys.ArrowUp || this.gamepad.forward;
    const movingBackward = this.keys.KeyS || this.keys.ArrowDown || this.gamepad.backward;

    if (aiming || turningLeft || turningRight || movingForward || movingBackward) {
      this.clearTarget();
    }

    const carrying = Boolean(this.isCarryMode?.());
    if (aiming && carrying) {
      if (!this.blockedAimActive) {
        this.onBlockedAim?.();
        this.blockedAimActive = true;
      }
    } else if (!aiming) {
      this.blockedAimActive = false;
    }

    if (aiming && !carrying) {
      this.state = 'aim';
      return this.state;
    }

    if (turningLeft) character.rotation.y += this.turnSpeed * delta;
    if (turningRight) character.rotation.y -= this.turnSpeed * delta;

    this.forward.set(0, 0, -1).applyQuaternion(character.quaternion);
    const walkSpeed = carrying ? this.carryWalkSpeed : this.walkSpeed;
    const backpedalSpeed = carrying ? this.carryBackpedalSpeed : this.backpedalSpeed;
    if (movingForward) {
      this.moveCharacter(character, this.forward, walkSpeed * delta);
    }
    if (movingBackward) {
      this.moveCharacter(character, this.forward, -backpedalSpeed * delta);
    }

    const pathSpeed = walkSpeed * this.pathSpeedMultiplier;
    const movingToTarget = this.updatePathMovement(character, delta, movingForward || movingBackward, pathSpeed);

    this.applyBounds(character);
    this.state = this.getMovementState({ turningLeft, turningRight, movingForward: movingForward || movingToTarget, movingBackward, carrying });
    return this.state;
  }

  updatePathMovement(character, delta, manualMovementActive, walkSpeed = this.walkSpeed) {
    if (manualMovementActive) {
      this.clearTarget();
      return false;
    }
    if (!this.targetPosition && this.path.length) {
      this.targetPosition = this.path[0];
    }
    if (!this.targetPosition) return false;

    this.toTarget.copy(this.targetPosition).sub(character.position);
    this.toTarget.y = 0;
    const distance = this.toTarget.length();
    if (distance <= this.arrivalDistance) {
      this.path.shift();
      this.targetPosition = this.path[0] || null;
      if (!this.targetPosition) {
        const onComplete = this.onPathComplete;
        this.onPathComplete = null;
        if (onComplete) onComplete();
        return false;
      }
      return true;
    }

    const desiredYaw = Math.atan2(-this.toTarget.x, -this.toTarget.z);
    const yawDelta = Math.atan2(
      Math.sin(desiredYaw - character.rotation.y),
      Math.cos(desiredYaw - character.rotation.y)
    );
    const turnStep = Math.min(1, this.targetTurnSharpness * delta);
    character.rotation.y += yawDelta * turnStep;

    this.forward.set(0, 0, -1).applyQuaternion(character.quaternion);
    const step = Math.min(walkSpeed * delta, distance);
    const didMove = this.moveCharacter(character, this.forward, step);
    if (!didMove) {
      this.clearTarget();
      return false;
    }
    return true;
  }

  moveCharacter(character, direction, distance) {
    const steps = Math.max(1, Math.ceil(Math.abs(distance) / this.maxStepDistance));
    const stepDistance = distance / steps;
    let didMove = false;

    for (let index = 0; index < steps; index += 1) {
      if (!this.moveCharacterStep(character, direction, stepDistance)) break;
      didMove = true;
    }

    return didMove;
  }

  moveCharacterStep(character, direction, distance) {
    this.candidatePosition.copy(character.position).addScaledVector(direction, distance);
    this.candidatePosition.y = this.getGroundYFor(this.candidatePosition);
    if (this.isPositionAllowed(this.candidatePosition, character.position)) {
      character.position.copy(this.candidatePosition);
      return true;
    }

    let didSlide = false;
    const originalX = character.position.x;
    const originalZ = character.position.z;

    this.candidatePosition.copy(character.position);
    this.candidatePosition.x = originalX + direction.x * distance;
    this.candidatePosition.y = this.getGroundYFor(this.candidatePosition);
    if (this.isPositionAllowed(this.candidatePosition, character.position)) {
      character.position.x = this.candidatePosition.x;
      didSlide = true;
    }

    this.candidatePosition.copy(character.position);
    this.candidatePosition.z = originalZ + direction.z * distance;
    this.candidatePosition.y = this.getGroundYFor(this.candidatePosition);
    if (this.isPositionAllowed(this.candidatePosition, character.position)) {
      character.position.z = this.candidatePosition.z;
      didSlide = true;
    }

    return didSlide;
  }

  isPositionAllowed(position, fromPosition = null) {
    if (this.bounds) {
      const insideBounds = position.x >= this.bounds.minX
        && position.x <= this.bounds.maxX
        && position.z >= this.bounds.minZ
        && position.z <= this.bounds.maxZ;
      if (!insideBounds) return false;
    }
    return this.canMoveTo ? this.canMoveTo(position, fromPosition) : true;
  }

  applyBounds(character) {
    if (this.bounds) {
      character.position.x = THREE.MathUtils.clamp(character.position.x, this.bounds.minX, this.bounds.maxX);
      character.position.z = THREE.MathUtils.clamp(character.position.z, this.bounds.minZ, this.bounds.maxZ);
    }
    character.position.y = this.getGroundYFor(character.position);
  }

  getMovementState({ turningLeft, turningRight, movingForward, movingBackward, carrying }) {
    if (carrying && (movingForward || movingBackward || turningLeft || turningRight)) return 'carry-walk';
    if (carrying) return 'carry-idle';
    if (movingForward) return 'walk';
    if (movingBackward) return 'backpedal';
    if (turningLeft) return 'turn-left';
    if (turningRight) return 'turn-right';
    return 'idle';
  }
}
