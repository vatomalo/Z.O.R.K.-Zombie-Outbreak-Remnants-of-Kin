import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.152.2/build/three.module.js';
import { FBXLoader } from 'https://cdn.jsdelivr.net/npm/three@0.152.2/examples/jsm/loaders/FBXLoader.js';

export class AnimationLibrary {
  constructor() {
    this.loader = this.createLoader();
    this.clips = new Map();
  }

  createLoader() {
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => url.replaceAll('\\', '/'));
    return new FBXLoader(manager);
  }

  load(name, path) {
    return new Promise((resolve, reject) => {
      this.loader.load(path, (fbx) => {
        const clips = fbx.animations || [];
        console.info(`Animation file "${path}" contains clips: ${clips.map((clip) => clip.name).join(', ') || 'none'}.`);
        const clip = this.pickClip(name, clips);
        if (!clip) {
          reject(new Error(`No animation clip found in ${path}`));
          return;
        }
        clip.name = name;
        this.clips.set(name, clip);
        resolve(clip);
      }, undefined, reject);
    });
  }

  get(name) {
    return this.clips.get(name);
  }

  pickClip(name, clips) {
    const normalizedName = name.toLowerCase();
    const aliases = {
      aim: ['shoot', 'gun', 'hold'],
    };
    const searchTerms = [normalizedName, ...(aliases[normalizedName] || [])];
    return clips.find((candidate) => {
      const clipName = candidate.name.toLowerCase();
      return searchTerms.some((term) => clipName.includes(term));
    }) || clips[0];
  }
}

export class ActorAnimator {
  constructor(root) {
    this.mixer = new THREE.AnimationMixer(root);
    this.actions = new Map();
    this.currentAction = null;
    this.currentName = null;
    this.holdAtTime = null;
  }

  addClip(name, clip) {
    const action = this.mixer.clipAction(clip);
    action.enabled = true;
    action.clampWhenFinished = false;
    action.loop = THREE.LoopRepeat;
    action.repetitions = Infinity;
    this.actions.set(name, action);
    return action;
  }

  hasAction(name) {
    return this.actions.has(name);
  }

  getClipDuration(name) {
    return this.actions.get(name)?.getClip().duration ?? 0;
  }

  play(name, fadeSeconds = 0.2, timeScale = 1) {
    const nextAction = this.actions.get(name);
    if (!nextAction || this.currentAction === nextAction) return;

    if (this.currentAction) {
      this.currentAction.fadeOut(fadeSeconds);
    }

    nextAction.reset();
    nextAction.setLoop(THREE.LoopRepeat, Infinity);
    nextAction.setEffectiveTimeScale(timeScale);
    nextAction.setEffectiveWeight(1);
    if (fadeSeconds > 0) {
      nextAction.fadeIn(fadeSeconds);
    }
    nextAction.play();

    this.currentAction = nextAction;
    this.currentName = name;
    this.holdAtTime = null;
    this.mixer.update(0);
  }

  playOnce(name, fadeSeconds = 0.12, timeScale = 1) {
    const nextAction = this.actions.get(name);
    if (!nextAction) return;

    if (this.currentAction && this.currentAction !== nextAction) {
      this.currentAction.fadeOut(fadeSeconds);
    }

    nextAction.reset();
    nextAction.setLoop(THREE.LoopOnce, 1);
    nextAction.setEffectiveTimeScale(timeScale);
    nextAction.setEffectiveWeight(1);
    nextAction.clampWhenFinished = true;
    if (fadeSeconds > 0 && this.currentAction !== nextAction) {
      nextAction.fadeIn(fadeSeconds);
    }
    nextAction.play();

    this.currentAction = nextAction;
    this.currentName = name;
    this.holdAtTime = null;
    this.mixer.update(0);
  }

  hold(name, timeSeconds, fadeSeconds = 0.12) {
    const nextAction = this.actions.get(name);
    if (!nextAction) return;

    if (this.currentAction && this.currentAction !== nextAction) {
      this.currentAction.fadeOut(fadeSeconds);
    }

    const clip = nextAction.getClip();
    nextAction.reset();
    nextAction.setLoop(THREE.LoopOnce, 1);
    nextAction.setEffectiveTimeScale(0);
    nextAction.setEffectiveWeight(1);
    nextAction.clampWhenFinished = true;
    nextAction.time = THREE.MathUtils.clamp(timeSeconds, 0, Math.max(clip.duration - 0.001, 0));
    if (fadeSeconds > 0 && this.currentAction !== nextAction) {
      nextAction.fadeIn(fadeSeconds);
    }
    nextAction.play();

    this.currentAction = nextAction;
    this.currentName = name;
    this.holdAtTime = null;
    this.mixer.update(0);
  }

  playUntilHold(name, holdTimeSeconds, fadeSeconds = 0.12, timeScale = 1) {
    const nextAction = this.actions.get(name);
    if (!nextAction || this.currentAction === nextAction) return;

    if (this.currentAction) {
      this.currentAction.fadeOut(fadeSeconds);
    }

    const clip = nextAction.getClip();
    this.holdAtTime = THREE.MathUtils.clamp(holdTimeSeconds, 0, Math.max(clip.duration - 0.001, 0));
    nextAction.reset();
    nextAction.setLoop(THREE.LoopOnce, 1);
    nextAction.setEffectiveTimeScale(timeScale);
    nextAction.setEffectiveWeight(1);
    nextAction.clampWhenFinished = true;
    if (fadeSeconds > 0) {
      nextAction.fadeIn(fadeSeconds);
    }
    nextAction.play();

    this.currentAction = nextAction;
    this.currentName = name;
  }

  update(delta) {
    this.mixer.update(delta);
    if (this.currentAction && this.holdAtTime !== null && this.currentAction.time >= this.holdAtTime) {
      this.currentAction.time = this.holdAtTime;
      this.currentAction.setEffectiveTimeScale(0);
      this.holdAtTime = null;
      this.mixer.update(0);
    }
  }

  getDebugState() {
    return {
      mixerTime: this.mixer.time,
      currentName: this.currentName,
      actionTime: this.currentAction?.time ?? 0,
      clipDuration: this.currentAction?.getClip().duration ?? 0,
      effectiveWeight: this.currentAction?.getEffectiveWeight() ?? 0,
      effectiveTimeScale: this.currentAction?.getEffectiveTimeScale() ?? 0,
      isRunning: this.currentAction?.isRunning() ?? false,
    };
  }
}
