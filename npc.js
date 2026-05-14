import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.152.2/build/three.module.js';
import { ActorAnimator } from './animation.js?v=actor-actions-1';

export class NPC {
  constructor({
    id,
    model,
    position,
    rotationY = 0,
    height = 1.5,
    visualRotation,
    visualMirrorY = false,
    animationLibrary,
    animations = {},
    movement = {},
    collisionRadius = 0.32,
  }) {
    this.id = id;
    this.model = model;
    this.animationLibrary = animationLibrary;
    this.animations = {
      idle: {
        clip: 'idle',
        speed: 1,
        startOffset: 0,
        ...(animations.idle || {}),
      },
      walk: {
        clip: 'walk',
        speed: 1,
        startOffset: 0,
        ...(animations.walk || {}),
      },
    };
    this.root = new THREE.Group();
    this.visual = new THREE.Group();
    this.animator = new ActorAnimator(this.model);
    this.currentState = null;
    this.homePosition = position.clone();
    this.walkSpeed = movement.walkSpeed ?? 0.55;
    this.collisionRadius = collisionRadius;
    this.turnSharpness = movement.turnSharpness ?? 7;
    this.arrivalDistance = movement.arrivalDistance ?? 0.12;
    this.waitSeconds = movement.waitSeconds ?? 1.4;
    this.waitTimer = movement.startWait ?? 0;
    this.pathIndex = 0;
    this.path = (movement.path || []).map((point) => this.homePosition.clone().add(point));
    this.forward = new THREE.Vector3();
    this.toTarget = new THREE.Vector3();
    this.candidatePosition = new THREE.Vector3();

    this.root.name = `${id}_NPC`;
    this.visual.name = `${id}_Visual`;
    this.visual.rotation.copy(visualRotation);
    this.visual.scale.y = visualMirrorY ? -1 : 1;
    this.visual.add(this.model);
    this.root.add(this.visual);
    this.root.position.copy(position);
    this.root.rotation.y = rotationY;
    this.root.userData = { actorType: 'npc', npcId: id };

    this.normalizeHeight(height);
    this.addAnimations();
    this.play('idle', 0);
  }

  normalizeHeight(targetHeight) {
    this.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.root);
    const size = new THREE.Vector3();
    box.getSize(size);
    this.visual.scale.multiplyScalar(targetHeight / (size.y || 1));

    this.root.updateMatrixWorld(true);
    const normalizedBox = new THREE.Box3().setFromObject(this.root);
    const center = new THREE.Vector3();
    normalizedBox.getCenter(center);
    this.visual.position.x -= center.x - this.root.position.x;
    this.visual.position.y -= normalizedBox.min.y;
    this.visual.position.z -= center.z - this.root.position.z;
  }

  addAnimations() {
    Object.entries(this.animations).forEach(([state, config]) => {
      const clip = this.animationLibrary.get(config.clip);
      if (!clip) return;
      this.animator.addClip(state, clip);
    });
  }

  play(state, fadeSeconds = 0.2) {
    if (this.currentState === state) return;
    const config = this.animations[state];
    if (!config) return;
    if (!this.hasAction(state)) return;
    this.currentState = state;
    this.animator.play(state, fadeSeconds, config.speed);
    if (config.startOffset && this.animator.currentAction) {
      const clip = this.animator.currentAction.getClip();
      this.animator.currentAction.time = config.startOffset % clip.duration;
    }
  }

  hasAction(state) {
    if (typeof this.animator.hasAction === 'function') {
      return this.animator.hasAction(state);
    }
    return this.animator.actions?.has?.(state) || false;
  }

  update(delta, collision = {}) {
    this.updateMovement(delta, collision);
    this.animator.update(delta);
  }

  updateMovement(delta, collision = {}) {
    if (!this.path.length) {
      this.play('idle');
      return;
    }

    if (this.waitTimer > 0) {
      this.waitTimer = Math.max(this.waitTimer - delta, 0);
      this.play('idle');
      return;
    }

    const target = this.path[this.pathIndex];
    this.toTarget.copy(target).sub(this.root.position);
    this.toTarget.y = 0;
    const distance = this.toTarget.length();

    if (distance <= this.arrivalDistance) {
      this.pathIndex = (this.pathIndex + 1) % this.path.length;
      this.waitTimer = this.waitSeconds;
      this.play('idle');
      return;
    }

    const desiredYaw = Math.atan2(-this.toTarget.x, -this.toTarget.z);
    const yawDelta = Math.atan2(
      Math.sin(desiredYaw - this.root.rotation.y),
      Math.cos(desiredYaw - this.root.rotation.y)
    );
    const turnStep = Math.min(1, this.turnSharpness * delta);
    this.root.rotation.y += yawDelta * turnStep;

    this.forward.set(0, 0, -1).applyQuaternion(this.root.quaternion);
    this.candidatePosition.copy(this.root.position).addScaledVector(this.forward, Math.min(this.walkSpeed * delta, distance));
    if (this.canMoveTo(this.candidatePosition, collision)) {
      this.root.position.copy(this.candidatePosition);
    } else {
      this.waitTimer = Math.max(this.waitTimer, 0.35);
      this.play('idle');
      return;
    }
    this.play('walk');
  }

  canMoveTo(position, collision = {}) {
    if (collision.canMoveTo && !collision.canMoveTo(position, this.root.position, this)) return false;
    return !this.isBlockedAt(position, collision.blockers || []);
  }

  isBlockedAt(position, blockers) {
    return blockers.some((blocker) => {
      if (!blocker || blocker === this) return false;
      const blockerPosition = blocker.root?.position || blocker.position;
      if (!blockerPosition) return false;
      const blockerRadius = blocker.collisionRadius ?? 0.32;
      const minDistance = this.collisionRadius + blockerRadius;
      const candidateDistance = Math.hypot(position.x - blockerPosition.x, position.z - blockerPosition.z);
      if (candidateDistance >= minDistance) return false;

      const currentDistance = Math.hypot(this.root.position.x - blockerPosition.x, this.root.position.z - blockerPosition.z);
      return candidateDistance < currentDistance;
    });
  }
}
