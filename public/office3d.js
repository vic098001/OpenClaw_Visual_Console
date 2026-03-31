import * as THREE from "/vendor/three/three.module.js";

const ROOM = {
  width: 30,
  depth: 20,
  height: 6.8
};

const STATE_STYLE = {
  RUNNING: { color: 0x80ff9b, emissive: 0x2f9b4f },
  ACTIVE: { color: 0x48f9ef, emissive: 0x1d94a2 },
  IDLE: { color: 0xffc86a, emissive: 0x8f6b29 },
  OFFLINE: { color: 0xff5b7a, emissive: 0x96233f }
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pickStateStyle(state) {
  return STATE_STYLE[state] || STATE_STYLE.OFFLINE;
}

function createLabelSprite(text, colorHex = "#d8f6ff") {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "rgba(3, 14, 26, 0.72)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "rgba(72,249,239,0.4)";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);

  ctx.fillStyle = colorHex;
  ctx.font = "700 28px Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(2.7, 0.67, 1);
  sprite.userData.texture = texture;
  return sprite;
}

export class Office3D {
  constructor({ container }) {
    if (!container) {
      throw new Error("Office3D requires a container element.");
    }

    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x040816);
    this.scene.fog = new THREE.Fog(0x040816, 16, 54);

    this.clock = new THREE.Clock();
    this.agentObjects = new Map();
    this.motionEnabled = true;
    this.cruiseMode = true;
    this.cruiseT = 0;
    this.running = true;
    this.manualTarget = new THREE.Vector3(0, 1.1, 0);
    this.manual = {
      radius: 21,
      yaw: 0.65,
      pitch: 0.32,
      dragging: false,
      pointerId: null,
      startX: 0,
      startY: 0,
      startYaw: 0,
      startPitch: 0
    };

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance"
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = false;
    this.container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(53, 1, 0.1, 120);
    this.camera.position.set(13, 9, 16);
    this.resetManualFromCamera();

    this.cruiseCurve = new THREE.CatmullRomCurve3(
      [
        new THREE.Vector3(13, 8.6, 16),
        new THREE.Vector3(-15, 7.5, 13),
        new THREE.Vector3(-17, 6.7, -10),
        new THREE.Vector3(6, 7.8, -16),
        new THREE.Vector3(17, 8.9, -2),
        new THREE.Vector3(12, 8.7, 16)
      ],
      true,
      "catmullrom",
      0.18
    );
    this.lookCurve = new THREE.CatmullRomCurve3(
      [
        new THREE.Vector3(-2.4, 0.9, -0.8),
        new THREE.Vector3(1.6, 1.2, -1.9),
        new THREE.Vector3(2.8, 1.1, 1.2),
        new THREE.Vector3(-1.4, 0.8, 2.2),
        new THREE.Vector3(-2.4, 0.9, -0.8)
      ],
      true,
      "catmullrom",
      0.3
    );

    this.addLights();
    this.buildRoom();
    this.onResize();
    this.bindManualControls();

    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(this.container);

    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  bindManualControls() {
    const canvas = this.renderer.domElement;

    this.onPointerDown = (event) => {
      if (this.cruiseMode || event.button !== 0) {
        return;
      }
      this.manual.dragging = true;
      this.manual.pointerId = event.pointerId;
      this.manual.startX = event.clientX;
      this.manual.startY = event.clientY;
      this.manual.startYaw = this.manual.yaw;
      this.manual.startPitch = this.manual.pitch;
      canvas.setPointerCapture(event.pointerId);
    };

    this.onPointerMove = (event) => {
      if (!this.manual.dragging || this.manual.pointerId !== event.pointerId) {
        return;
      }
      const dx = event.clientX - this.manual.startX;
      const dy = event.clientY - this.manual.startY;
      this.manual.yaw = this.manual.startYaw - dx * 0.0042;
      this.manual.pitch = clamp(this.manual.startPitch - dy * 0.0034, -0.05, 0.68);
      this.updateManualCamera();
    };

    this.onPointerUp = (event) => {
      if (this.manual.pointerId !== event.pointerId) {
        return;
      }
      this.manual.dragging = false;
      this.manual.pointerId = null;
      canvas.releasePointerCapture(event.pointerId);
    };

    this.onWheel = (event) => {
      if (this.cruiseMode) {
        return;
      }
      event.preventDefault();
      const delta = Math.sign(event.deltaY);
      this.manual.radius = clamp(this.manual.radius + delta * 0.8, 8, 38);
      this.updateManualCamera();
    };

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
  }

  resetManualFromCamera() {
    const offset = this.camera.position.clone().sub(this.manualTarget);
    const radius = Math.max(1, offset.length());
    this.manual.radius = clamp(radius, 8, 38);
    this.manual.yaw = Math.atan2(offset.x, offset.z);
    this.manual.pitch = clamp(Math.asin(offset.y / radius), -0.05, 0.68);
    this.updateManualCamera();
  }

  updateManualCamera() {
    const cosPitch = Math.cos(this.manual.pitch);
    this.camera.position.set(
      this.manualTarget.x + this.manual.radius * Math.sin(this.manual.yaw) * cosPitch,
      this.manualTarget.y + this.manual.radius * Math.sin(this.manual.pitch),
      this.manualTarget.z + this.manual.radius * Math.cos(this.manual.yaw) * cosPitch
    );
    this.camera.lookAt(this.manualTarget);
  }

  addLights() {
    const hemi = new THREE.HemisphereLight(0x57c8ff, 0x091428, 0.56);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0x98d5ff, 0.62);
    key.position.set(8, 14, 6);
    this.scene.add(key);

    const fill = new THREE.PointLight(0x48f9ef, 0.35, 40);
    fill.position.set(-7, 5.5, -4);
    this.scene.add(fill);
  }

  buildRoom() {
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM.width, ROOM.depth),
      new THREE.MeshStandardMaterial({
        color: 0x0a1a30,
        metalness: 0.22,
        roughness: 0.67
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0;
    this.scene.add(floor);

    const floorGrid = new THREE.GridHelper(
      ROOM.width,
      34,
      0x2f8ec2,
      0x174168
    );
    floorGrid.position.y = 0.01;
    floorGrid.material.opacity = 0.28;
    floorGrid.material.transparent = true;
    this.scene.add(floorGrid);

    this.addWallFrame();
    this.addWindowWall();
    this.addZonePads();
    this.addDeskBlocks();
  }

  addWallFrame() {
    const shape = new THREE.Shape();
    const w = ROOM.width / 2;
    const d = ROOM.depth / 2;
    shape.moveTo(-w, -d);
    shape.lineTo(w, -d);
    shape.lineTo(w, d);
    shape.lineTo(-w, d);
    shape.lineTo(-w, -d);
    const points = shape.getPoints(4);
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.LineLoop(
      geometry,
      new THREE.LineBasicMaterial({ color: 0x4aa8df })
    );
    line.rotation.x = -Math.PI / 2;
    line.position.y = 0.02;
    this.scene.add(line);

    const edgeGeom = new THREE.EdgesGeometry(
      new THREE.BoxGeometry(ROOM.width, ROOM.height, ROOM.depth)
    );
    const edge = new THREE.LineSegments(
      edgeGeom,
      new THREE.LineBasicMaterial({
        color: 0x1e4f79,
        transparent: true,
        opacity: 0.32
      })
    );
    edge.position.y = ROOM.height / 2;
    this.scene.add(edge);
  }

  addWindowWall() {
    const paneMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x10263f,
      transparent: true,
      opacity: 0.3,
      roughness: 0.16,
      metalness: 0.25,
      transmission: 0.45
    });

    const pane = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM.width * 0.86, ROOM.height * 0.72),
      paneMaterial
    );
    pane.position.set(0, ROOM.height * 0.5, -ROOM.depth * 0.5 + 0.08);
    this.scene.add(pane);

    const cityLine = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM.width * 0.86, ROOM.height * 0.72),
      new THREE.MeshBasicMaterial({
        color: 0x0b1530,
        transparent: true,
        opacity: 0.45
      })
    );
    cityLine.position.copy(pane.position);
    cityLine.position.z -= 0.03;
    this.scene.add(cityLine);
  }

  addZonePads() {
    const zonePads = [
      { x: -9.5, z: -5.2, w: 7.4, d: 4.4, color: 0x12375f },
      { x: 0.4, z: -5.4, w: 8.2, d: 4.4, color: 0x173e62 },
      { x: 10.2, z: -4.2, w: 6.1, d: 5.4, color: 0x19395a },
      { x: -6.5, z: 5.7, w: 9.6, d: 5.9, color: 0x153554 },
      { x: 8.5, z: 5.9, w: 7.3, d: 5.2, color: 0x13324d }
    ];

    for (const pad of zonePads) {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(pad.w, pad.d),
        new THREE.MeshStandardMaterial({
          color: pad.color,
          metalness: 0.3,
          roughness: 0.7,
          emissive: 0x04101d,
          emissiveIntensity: 0.68
        })
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(pad.x, 0.02, pad.z);
      this.scene.add(mesh);
    }
  }

  addDeskBlocks() {
    const material = new THREE.MeshStandardMaterial({
      color: 0x0f2a45,
      metalness: 0.45,
      roughness: 0.45
    });
    const blocks = [
      { x: -10.3, y: 0.44, z: -5.1, w: 2.4, h: 0.86, d: 1.4 },
      { x: -7.5, y: 0.44, z: -5.8, w: 2.4, h: 0.86, d: 1.4 },
      { x: 0.2, y: 0.44, z: -5.6, w: 2.8, h: 0.86, d: 1.4 },
      { x: 3.4, y: 0.44, z: -5.0, w: 2.8, h: 0.86, d: 1.4 },
      { x: 9.8, y: 0.82, z: -3.8, w: 2.6, h: 1.64, d: 1.2 },
      { x: -3.6, y: 0.44, z: 5.5, w: 2.6, h: 0.86, d: 1.4 },
      { x: 8.6, y: 0.44, z: 5.6, w: 2.6, h: 0.86, d: 1.4 }
    ];

    for (const block of blocks) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(block.w, block.h, block.d),
        material
      );
      mesh.position.set(block.x, block.y, block.z);
      this.scene.add(mesh);
    }
  }

  toRoomPosition(percentX, percentY) {
    const x = (clamp(percentX, 3, 97) / 100 - 0.5) * (ROOM.width - 1.6);
    const z = (clamp(percentY, 5, 95) / 100 - 0.5) * (ROOM.depth - 1.4);
    return new THREE.Vector3(x, 0.45, z);
  }

  createAgentObject(agent) {
    const style = pickStateStyle(agent.state);
    const group = new THREE.Group();

    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 20, 20),
      new THREE.MeshStandardMaterial({
        color: style.color,
        emissive: style.emissive,
        emissiveIntensity: 0.62,
        metalness: 0.35,
        roughness: 0.25
      })
    );
    group.add(core);

    const halo = new THREE.Mesh(
      new THREE.TorusGeometry(0.46, 0.03, 10, 24),
      new THREE.MeshBasicMaterial({
        color: style.color,
        transparent: true,
        opacity: 0.88
      })
    );
    halo.rotation.x = Math.PI / 2;
    group.add(halo);

    const beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.08, 0.55, 10),
      new THREE.MeshBasicMaterial({
        color: style.color,
        transparent: true,
        opacity: 0.62
      })
    );
    beacon.position.y = 0.62;
    group.add(beacon);

    const label = createLabelSprite(agent.id);
    label.position.set(0, 1.1, 0);
    group.add(label);

    group.userData = {
      id: agent.id,
      core,
      halo,
      beacon,
      label,
      targetPosition: this.toRoomPosition(agent.x, agent.y),
      state: agent.state,
      energy: clamp(agent.energy || 0.3, 0.1, 1),
      seed: Math.random() * Math.PI * 2
    };
    group.position.copy(group.userData.targetPosition);
    return group;
  }

  updateAgents(agents = []) {
    const incoming = new Set();
    for (const agent of agents) {
      incoming.add(agent.id);
      const existing = this.agentObjects.get(agent.id);
      if (!existing) {
        const created = this.createAgentObject(agent);
        this.agentObjects.set(agent.id, created);
        this.scene.add(created);
      } else {
        const style = pickStateStyle(agent.state);
        const data = existing.userData;
        data.targetPosition = this.toRoomPosition(agent.x, agent.y);
        data.energy = clamp(agent.energy || data.energy || 0.3, 0.1, 1);
        if (data.state !== agent.state) {
          data.core.material.color.setHex(style.color);
          data.core.material.emissive.setHex(style.emissive);
          data.halo.material.color.setHex(style.color);
          data.beacon.material.color.setHex(style.color);
          data.state = agent.state;
        }
      }
    }

    for (const [id, object] of this.agentObjects.entries()) {
      if (!incoming.has(id)) {
        this.scene.remove(object);
        object.traverse((child) => {
          if (child.material?.map) {
            child.material.map.dispose();
          }
          if (child.material) {
            child.material.dispose();
          }
          if (child.geometry) {
            child.geometry.dispose();
          }
        });
        this.agentObjects.delete(id);
      }
    }
  }

  setMotionEnabled(enabled) {
    this.motionEnabled = Boolean(enabled);
  }

  setCruiseMode(enabled) {
    this.cruiseMode = Boolean(enabled);
    if (!this.cruiseMode) {
      this.updateManualCamera();
    }
  }

  resetCamera() {
    if (this.cruiseMode) {
      this.cruiseT = 0;
      const cruisePos = this.cruiseCurve.getPointAt(0);
      this.camera.position.copy(cruisePos);
      this.camera.lookAt(0, 1.1, 0);
      return;
    }
    this.camera.position.set(13, 9, 16);
    this.resetManualFromCamera();
  }

  focusAgent(agentId) {
    const targetObject = this.agentObjects.get(agentId);
    if (!targetObject) {
      return false;
    }

    const target = targetObject.position.clone();
    target.y = 1.05;
    const offset = this.camera.position.clone().sub(this.manualTarget);
    if (offset.lengthSq() < 0.1) {
      offset.set(10, 7, 12);
    }

    this.cruiseMode = false;
    this.manualTarget.copy(target);
    offset.setLength(clamp(offset.length(), 9, 26));
    this.camera.position.copy(target.clone().add(offset));
    this.resetManualFromCamera();
    return true;
  }

  onResize() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  animate() {
    if (!this.running) {
      return;
    }
    requestAnimationFrame(this.animate);
    const dt = clamp(this.clock.getDelta(), 0.001, 0.05);
    const elapsed = this.clock.elapsedTime;

    if (this.cruiseMode) {
      this.cruiseT = (this.cruiseT + dt * 0.028) % 1;
      const camPos = this.cruiseCurve.getPointAt(this.cruiseT);
      const lookPos = this.lookCurve.getPointAt((this.cruiseT + 0.08) % 1);
      this.camera.position.lerp(camPos, 0.08);
      this.camera.lookAt(lookPos);
    }

    for (const object of this.agentObjects.values()) {
      const data = object.userData;
      if (this.motionEnabled) {
        object.position.lerp(data.targetPosition, 0.07);
      } else {
        object.position.copy(data.targetPosition);
      }

      const pulse = 1 + Math.sin(elapsed * 4.2 + data.seed) * (0.04 + data.energy * 0.05);
      const hover = Math.sin(elapsed * 2.4 + data.seed) * (0.05 + data.energy * 0.07);
      data.halo.rotation.z += 0.018 + data.energy * 0.013;

      object.scale.setScalar(pulse);
      data.halo.material.opacity = 0.4 + data.energy * 0.5;
      data.core.material.emissiveIntensity = 0.3 + data.energy * 0.85;
      data.beacon.position.y = 0.62 + hover;
      data.label.position.y = 1.1 + hover * 0.3;
    }

    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.running = false;
    this.resizeObserver?.disconnect();
    const canvas = this.renderer?.domElement;
    if (canvas) {
      canvas.removeEventListener("pointerdown", this.onPointerDown);
      canvas.removeEventListener("pointermove", this.onPointerMove);
      canvas.removeEventListener("pointerup", this.onPointerUp);
      canvas.removeEventListener("pointercancel", this.onPointerUp);
      canvas.removeEventListener("wheel", this.onWheel);
    }
    this.renderer?.dispose();
  }
}
