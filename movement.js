import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.152.2/build/three.module.js';

export class TankMovementController {
  constructor({
    getCharacter,
    walkSpeed = 1.8,
    backpedalSpeed = 1.15,
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
  }) {
    this.getCharacter = getCharacter;
    this.walkSpeed = walkSpeed;
    this.backpedalSpeed = backpedalSpeed;
    this.turnSpeed = turnSpeed;
    this.bounds = bounds;
    this.canMoveTo = canMoveTo;
    this.getGroundY = getGroundY;
    this.arrivalDistance = arrivalDistance;
    this.targetTurnSharpness = targetTurnSharpness;
    this.maxStepDistance = maxStepDistance;
    this.targetPosition = null;
    this.keys = {};
    this.state = 'idle';
    this.forward = new THREE.Vector3();
    this.toTarget = new THREE.Vector3();
    this.candidatePosition = new THREE.Vector3();
    this.enabled = true;
  }

  getGroundYFor(position = null) {
    return this.getGroundY ? this.getGroundY(position) : 0;
  }

  attach() {
    window.addEventListener('keydown', (event) => this.handleKey(event, true));
    window.addEventListener('keyup', (event) => this.handleKey(event, false));
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

  setTarget(position) {
    this.targetPosition = position.clone();
    this.targetPosition.y = this.getGroundYFor(this.targetPosition);
  }

  clearTarget() {
    this.targetPosition = null;
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

    const aiming = this.keys.ControlLeft || this.keys.ControlRight;
    const turningLeft = this.keys.KeyA || this.keys.ArrowLeft;
    const turningRight = this.keys.KeyD || this.keys.ArrowRight;
    const movingForward = this.keys.KeyW || this.keys.ArrowUp;
    const movingBackward = this.keys.KeyS || this.keys.ArrowDown;

    if (aiming || turningLeft || turningRight || movingForward || movingBackward) {
      this.clearTarget();
    }

    if (aiming) {
      this.state = 'aim';
      return this.state;
    }

    if (turningLeft) character.rotation.y += this.turnSpeed * delta;
    if (turningRight) character.rotation.y -= this.turnSpeed * delta;

    this.forward.set(0, 0, -1).applyQuaternion(character.quaternion);
    if (movingForward) {
      this.moveCharacter(character, this.forward, this.walkSpeed * delta);
    }
    if (movingBackward) {
      this.moveCharacter(character, this.forward, -this.backpedalSpeed * delta);
    }

    const movingToTarget = this.updateTargetMovement(character, delta, movingForward || movingBackward);

    this.applyBounds(character);
    this.state = this.getMovementState({ turningLeft, turningRight, movingForward: movingForward || movingToTarget, movingBackward });
    return this.state;
  }

  updateTargetMovement(character, delta, manualMovementActive) {
    if (!this.targetPosition || manualMovementActive) return false;

    this.toTarget.copy(this.targetPosition).sub(character.position);
    this.toTarget.y = 0;
    const distance = this.toTarget.length();
    if (distance <= this.arrivalDistance) {
      this.clearTarget();
      return false;
    }

    const desiredYaw = Math.atan2(-this.toTarget.x, -this.toTarget.z);
    const yawDelta = Math.atan2(
      Math.sin(desiredYaw - character.rotation.y),
      Math.cos(desiredYaw - character.rotation.y)
    );
    const turnStep = Math.min(1, this.targetTurnSharpness * delta);
    character.rotation.y += yawDelta * turnStep;

    this.forward.set(0, 0, -1).applyQuaternion(character.quaternion);
    const step = Math.min(this.walkSpeed * delta, distance);
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

  getMovementState({ turningLeft, turningRight, movingForward, movingBackward }) {
    if (movingForward) return 'walk';
    if (movingBackward) return 'backpedal';
    if (turningLeft) return 'turn-left';
    if (turningRight) return 'turn-right';
    return 'idle';
  }
}
