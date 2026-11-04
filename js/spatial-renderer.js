/* =============================================================
   spatial-renderer.js - 60fps Canvas 3D perspective engine
   Curved windows, desk grid, comfort cone, 25-joint hands,
   pinch rays, snap rings, SPECS HUD waveguide frame
   ============================================================= */

class SpatialRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = 0; this.h = 0;
    this.camYaw = -0.18;
    this.camPitch = -0.22;
    this.camDist = 1.15;
    this.worldYaw = 0; // orbit
    this.t = 0;

    // Scene state (bound externally)
    this.windows = [];
    this.hands = []; // { handedness, joints, pinchState, pinchPoint }
    this.viewMode = "quest"; // quest | specs | cone
    this.comfortCone = { enabled: true, angleDeg: 30, radiusM: 0.45 };
    this.curvedRadius = 0.85;
    this.grabbedWindow = null;
    this.hoverWindow = null;
    this._resize();
    window.addEventListener("resize", () => this._resize());
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.w = rect.width; this.h = rect.height;
    this.canvas.width = this.w * this.dpr;
    this.canvas.height = this.h * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  setWorldYaw(v) { this.worldYaw = v; }

  // ---------- 3D math ----------
  project(p) {
    // p in world meters (x,y,z) - y up, z forward
    // Apply worldYaw, then camera
    let x = p.x * Math.cos(this.worldYaw) + p.z * Math.sin(this.worldYaw);
    let z = -p.x * Math.sin(this.worldYaw) + p.z * Math.cos(this.worldYaw);
    let y = p.y;

    // Camera orbit
    const cx = Math.sin(this.camYaw) * this.camDist;
    const cz = Math.cos(this.camYaw) * this.camDist;
    const cy = Math.sin(this.camPitch) * this.camDist;
    // Simple perspective: translate to camera, then project
    // Camera at (cx, cy, cz) looking at origin
    // For simplicity use pinhole centered on canvas
    x -= 0; y -= 0.02; z -= 0.35;

    // Rotate by -camYaw around Y, -camPitch around X
    const cosY = Math.cos(-this.camYaw), sinY = Math.sin(-this.camYaw);
    let rx = x * cosY - z * sinY;
    let rz = x * sinY + z * cosY;
    const cosP = Math.cos(-this.camPitch), sinP = Math.sin(-this.camPitch);
    let ry = y * cosP - rz * sinP;
    rz = y * sinP + rz * cosP;

    // Perspective
    const focal = 520; // px
    const camZ = 1.45;
    const depth = rz + camZ;
    if (depth <= 0.06) return null;
    const s = focal / depth;
    return {
      x: this.w / 2 + rx * s,
      y: this.h / 2 - ry * s,
      s, depth,
      world: p
    };
  }

  // ---------- Drawing helpers ----------
  _line(a, b, color, width = 1, dash = null) {
    if (!a || !b) return;
    this.ctx.save();
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = width;
    if (dash) this.ctx.setLineDash(dash);
    this.ctx.beginPath();
    this.ctx.moveTo(a.x, a.y);
    this.ctx.lineTo(b.x, b.y);
    this.ctx.stroke();
    this.ctx.restore();
  }
  _circle(pt, r, stroke, fill = null, width = 1) {
    if (!pt) return;
    this.ctx.save();
    if (fill) { this.ctx.fillStyle = fill; this.ctx.beginPath(); this.ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2); this.ctx.fill(); }
    if (stroke) { this.ctx.strokeStyle = stroke; this.ctx.lineWidth = width; this.ctx.beginPath(); this.ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2); this.ctx.stroke(); }
    this.ctx.restore();
  }

  // ---------- Scene primitives ----------
  drawDeskGrid() {
    const ctx = this.ctx;
    const gridY = -0.28;
    const size = 1.4;
    const step = 0.14;
    ctx.save();
    // Desk surface rectangle
    const corners = [
      { x: -size / 2, y: gridY, z: 0.1 },
      { x: size / 2, y: gridY, z: 0.1 },
      { x: size / 2, y: gridY, z: -0.7 },
      { x: -size / 2, y: gridY, z: -0.7 },
    ].map(p => this.project(p));
    if (corners.every(Boolean)) {
      ctx.fillStyle = "rgba(56,189,248,0.04)";
      ctx.strokeStyle = "rgba(56,189,248,0.14)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      corners.forEach(c => ctx.lineTo(c.x, c.y));
      ctx.closePath();
      ctx.fill(); ctx.stroke();
    }
    // Grid lines
    for (let x = -size / 2; x <= size / 2 + 1e-6; x += step) {
      const a = this.project({ x, y: gridY, z: 0.1 });
      const b = this.project({ x, y: gridY, z: -0.7 });
      this._line(a, b, "rgba(148,163,184,0.09)", 1);
    }
    for (let z = -0.7; z <= 0.1 + 1e-6; z += step) {
      const a = this.project({ x: -size / 2, y: gridY, z });
      const b = this.project({ x: size / 2, y: gridY, z });
      this._line(a, b, "rgba(148,163,184,0.09)", 1);
    }
    // Center cross
    const cx1 = this.project({ x: 0, y: gridY, z: 0 }); // not used
    ctx.restore();
  }

  drawComfortCone() {
    if (!this.comfortCone.enabled) return;
    const ctx = this.ctx;
    const apex = { x: 0, y: -0.28, z: 0.18 }; // rested elbow position
    const angle = this.comfortCone.angleDeg * Math.PI / 180;
    const r = this.comfortCone.radiusM;
    const segments = 28;

    ctx.save();
    // Cone wireframe: apex to ring
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const ringX = Math.cos(a) * r * Math.sin(angle * 2);
      const ringY = apex.y + r * Math.cos(angle) * 0.55;
      const ringZ = apex.z - 0.18 + Math.sin(a) * r * Math.sin(angle) * 0.6;
      // Spoke
      const pa = this.project(apex);
      const pr = this.project({ x: ringX, y: ringY, z: ringZ });
      if (pa && pr) {
        ctx.strokeStyle = i % 4 === 0 ? "rgba(16,185,129,0.22)" : "rgba(16,185,129,0.09)";
        ctx.lineWidth = i % 4 === 0 ? 1 : 0.8;
        ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pr.x, pr.y); ctx.stroke();
      }
    }
    // Ring
    ctx.strokeStyle = "rgba(16,185,129,0.28)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const ringX = Math.cos(a) * r * Math.sin(angle * 2);
      const ringY = apex.y + r * Math.cos(angle) * 0.55;
      const ringZ = apex.z - 0.18 + Math.sin(a) * r * Math.sin(angle) * 0.6;
      const pp = this.project({ x: ringX, y: ringY, z: ringZ });
      if (!pp) continue;
      if (i === 0) ctx.moveTo(pp.x, pp.y); else ctx.lineTo(pp.x, pp.y);
    }
    ctx.stroke();

    // Label
    const labelPos = this.project({ x: 0.32, y: 0.08, z: -0.05 });
    if (labelPos) {
      ctx.fillStyle = "rgba(16,185,129,0.95)";
      ctx.font = "700 10px Inter, system-ui, sans-serif";
      ctx.fillText("◉ 30° Rested-Arm Comfort Cone", labelPos.x, labelPos.y);
      ctx.fillStyle = "rgba(148,163,184,0.9)";
      ctx.font = "500 10px Inter, system-ui, sans-serif";
      ctx.fillText("68.4% less deltoid torque vs extended reach", labelPos.x, labelPos.y + 13);
    }
    ctx.restore();
  }

  drawCurvedGuides() {
    const ctx = this.ctx;
    // Curved desk arc at y=-0.28
    ctx.save();
    ctx.strokeStyle = "rgba(56,189,248,0.10)";
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 6]);
    ctx.beginPath();
    const R = this.curvedRadius;
    for (let a = -0.85; a <= 0.85; a += 0.02) {
      const x = Math.sin(a) * R;
      const z = Math.cos(a) * R - R + 0.02;
      const pp = this.project({ x, y: -0.27, z });
      if (!pp) continue;
      if (a === -0.85) ctx.moveTo(pp.x, pp.y); else ctx.lineTo(pp.x, pp.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawWindows() {
    const ctx = this.ctx;
    // Sort back-to-front by depth
    const withDepth = this.windows.map(w => {
      const c = this.project({ x: w.x, y: w.y, z: w.z });
      return { w, depth: c ? c.depth : -999, center: c };
    }).sort((a, b) => b.depth - a.depth);

    for (const { w, center } of withDepth) {
      if (!center) continue;
      // Compute window corners in world space with slight cylindrical curve + tilt
      const hw = w.w / 2, hh = w.h / 2;
      // Window is a billboard facing slightly inward (yaw toward center)
      const yaw = w.yaw || 0;
      const cosYaw = Math.cos(yaw), sinYaw = Math.sin(yaw);
      const cornersLocal = [
        { x: -hw, y: hh, z: 0 }, { x: hw, y: hh, z: 0 },
        { x: hw, y: -hh, z: 0 }, { x: -hw, y: -hh, z: 0 },
      ];
      const corners = cornersLocal.map(p => {
        const xr = p.x * cosYaw - p.z * sinYaw;
        const zr = p.x * sinYaw + p.z * cosYaw;
        return this.project({ x: w.x + xr, y: w.y + p.y, z: w.z + zr });
      });
      if (corners.some(c => !c)) continue;

      const isGrabbed = this.grabbedWindow === w.id;
      const isHover = this.hoverWindow === w.id;

      // Shadow
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.22)";
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      corners.forEach(c => ctx.lineTo(c.x, c.y));
      ctx.closePath();
      ctx.shadowColor = w.accent || "rgba(56,189,248,0.45)";
      ctx.shadowBlur = isGrabbed ? 22 : isHover ? 16 : 10;
      ctx.fill();
      ctx.shadowBlur = 0;

      // Glass fill
      const grad = ctx.createLinearGradient(corners[0].x, corners[0].y, corners[2].x, corners[2].y);
      grad.addColorStop(0, isGrabbed ? "rgba(56,189,248,0.18)" : "rgba(255,255,255,0.07)");
      grad.addColorStop(1, "rgba(255,255,255,0.03)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      corners.forEach(c => ctx.lineTo(c.x, c.y));
      ctx.closePath();
      ctx.fill();

      // Border
      ctx.strokeStyle = isGrabbed ? (w.accent || "#38BDF8") : isHover ? "rgba(56,189,248,0.55)" : "rgba(255,255,255,0.10)";
      ctx.lineWidth = isGrabbed ? 1.6 : 1;
      ctx.stroke();

      // Header strip
      const headerH = 18;
      // Clip to window
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      corners.forEach(c => ctx.lineTo(c.x, c.y));
      ctx.closePath();
      ctx.clip();

      // Compute header quad (top edge inset)
      const topEdgeLen = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y);
      // Simple: draw header as filled rect across top
      ctx.fillStyle = isGrabbed ? "rgba(56,189,248,0.22)" : "rgba(255,255,255,0.06)";
      // Use a horizontal band
      const minY = Math.min(...corners.map(c => c.y));
      const maxX = Math.max(...corners.map(c => c.x));
      const minX = Math.min(...corners.map(c => c.x));
      ctx.fillRect(minX, minY, maxX - minX, headerH);

      // Title
      ctx.fillStyle = "rgba(226,232,240,0.95)";
      ctx.font = "700 11px Inter, system-ui, sans-serif";
      ctx.fillText(w.title || w.id, minX + 8, minY + 12);

      // Tiny content lines
      if (w.lines) {
        ctx.fillStyle = "rgba(148,163,184,0.95)";
        ctx.font = "500 9.5px JetBrains Mono, monospace";
        let ly = minY + headerH + 12;
        for (const line of w.lines.slice(0, 4)) {
          ctx.fillText(line, minX + 8, ly);
          ly += 11;
        }
      }

      // Corner grab handles when hovered/grabbed
      if (isHover || isGrabbed) {
        const handleR = 4;
        for (const c of corners) {
          ctx.fillStyle = isGrabbed ? "#38BDF8" : "rgba(56,189,248,0.9)";
          ctx.beginPath(); ctx.arc(c.x, c.y, handleR, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = 1; ctx.stroke();
        }
      }

      ctx.restore(); // clip
      ctx.restore();

      // Snap ring when grabbed near dock
      if (isGrabbed && w.snapProgress > 0) {
        const snapR = 10 + (1 - w.snapProgress) * 18;
        const alpha = w.snapProgress;
        this._circle(center, snapR, `rgba(16,185,129,${0.55 * alpha})`, null, 1.5);
        this._circle(center, snapR * 0.55, null, `rgba(16,185,129,${0.18 * alpha})`);
      }
    }
  }

  drawHands() {
    for (const hand of this.hands) {
      if (!hand.joints) continue;
      this._drawSingleHand(hand);
    }
  }

  _drawSingleHand(hand) {
    const ctx = this.ctx;
    // Project all joints to screen
    const screenJoints = {};
    for (const [name, pos] of Object.entries(hand.joints)) {
      // Hand world offset
      const world = {
        x: (hand.worldX || 0) + pos.x,
        y: (hand.worldY || 0) + pos.y,
        z: (hand.worldZ || 0) + pos.z
      };
      screenJoints[name] = { world, screen: this.project(world), local: pos };
    }

    const isPinching = hand.pinchState === "PINCH_START" || hand.pinchState === "DRAGGING";
    const isHover = hand.pinchState === "HOVER";

    // Bones: for each finger chain, draw segments
    const fingerGroups = {
      thumb: ["wrist","thumb-metacarpal","thumb-phalanx-proximal","thumb-phalanx-distal","thumb-tip"],
      index: ["wrist","index-finger-metacarpal","index-finger-phalanx-proximal","index-finger-phalanx-intermediate","index-finger-phalanx-distal","index-finger-tip"],
      middle:["wrist","middle-finger-metacarpal","middle-finger-phalanx-proximal","middle-finger-phalanx-intermediate","middle-finger-phalanx-distal","middle-finger-tip"],
      ring:  ["wrist","ring-finger-metacarpal","ring-finger-phalanx-proximal","ring-finger-phalanx-intermediate","ring-finger-phalanx-distal","ring-finger-tip"],
      pinky: ["wrist","pinky-finger-metacarpal","pinky-finger-phalanx-proximal","pinky-finger-phalanx-intermediate","pinky-finger-phalanx-distal","pinky-finger-tip"],
    };

    ctx.save();
    // Bones
    for (const chain of Object.values(fingerGroups)) {
      for (let i = 0; i < chain.length - 1; i++) {
        const a = screenJoints[chain[i]]?.screen;
        const b = screenJoints[chain[i + 1]]?.screen;
        if (!a || !b) continue;
        this._line(a, b, isPinching ? "rgba(168,85,247,0.55)" : "rgba(148,163,184,0.28)", 1.4);
      }
    }

    // Palm polygon (wrist + metacarpals)
    const palmNames = ["wrist","thumb-metacarpal","index-finger-metacarpal","middle-finger-metacarpal","ring-finger-metacarpal","pinky-finger-metacarpal"];
    const palmPts = palmNames.map(n => screenJoints[n]?.screen).filter(Boolean);
    if (palmPts.length >= 3) {
      ctx.fillStyle = isPinching ? "rgba(168,85,247,0.08)" : "rgba(255,255,255,0.04)";
      ctx.strokeStyle = isPinching ? "rgba(168,85,247,0.22)" : "rgba(255,255,255,0.07)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(palmPts[0].x, palmPts[0].y);
      palmPts.forEach(p => ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fill(); ctx.stroke();
    }

    // Joints as dots
    for (const [name, sj] of Object.entries(screenJoints)) {
      if (!sj.screen) continue;
      const isTip = name.endsWith("-tip");
      const r = isTip ? 3.2 : name === "wrist" ? 3.6 : 2.1;
      const fill = isTip ? (isPinching ? "#A855F7" : "rgba(56,189,248,0.95)") : "rgba(226,232,240,0.85)";
      const stroke = "rgba(9,13,22,0.9)";
      this._circle(sj.screen, r, stroke, fill, 1);
      // Joint label on hover for thumb/index tips
      if ((name === "thumb-tip" || name === "index-finger-tip") && isHover) {
        ctx.fillStyle = "rgba(56,189,248,0.95)";
        ctx.font = "600 9px Inter, sans-serif";
        ctx.fillText(name === "thumb-tip" ? "thumb-tip" : "index-tip", sj.screen.x + 6, sj.screen.y - 6);
      }
    }

    // Pinch ray: from index tip outward
    const indexTipS = screenJoints["index-finger-tip"]?.screen;
    const indexTipW = screenJoints["index-finger-tip"]?.world;
    if (indexTipS && indexTipW) {
      // Ray direction: slightly forward along +Z in hand local, converted to world
      const rayLen = isPinching ? 0.28 : 0.42;
      const rayEndWorld = {
        x: indexTipW.x + (Math.sin(hand.yaw || 0) * rayLen * 0.1),
        y: indexTipW.y + 0.02,
        z: indexTipW.z + rayLen
      };
      const rayEnd = this.project(rayEndWorld);
      if (rayEnd) {
        const rayColor = isPinching ? "rgba(168,85,247,0.9)" : "rgba(56,189,248,0.55)";
        this._line(indexTipS, rayEnd, rayColor, isPinching ? 1.6 : 1, isPinching ? null : [6, 6]);
        // Contact sphere at ray end
        this._circle(rayEnd, isPinching ? 4 : 3, rayColor, isPinching ? "rgba(168,85,247,0.22)" : "rgba(56,189,248,0.14)", 1.2);
      }
    }

    // Pinch contact sphere between thumb and index tips
    const thumbS = screenJoints["thumb-tip"]?.screen;
    if (thumbS && indexTipS && (isPinching || isHover)) {
      const mx = (thumbS.x + indexTipS.x) / 2;
      const my = (thumbS.y + indexTipS.y) / 2;
      const distPx = Math.hypot(thumbS.x - indexTipS.x, thumbS.y - indexTipS.y);
      const snapR = Math.max(6, distPx * 0.6);
      ctx.save();
      ctx.strokeStyle = isPinching ? "rgba(16,185,129,0.85)" : "rgba(245,158,11,0.75)";
      ctx.lineWidth = 1.4;
      ctx.setLineDash(isPinching ? [] : [4, 4]);
      ctx.beginPath(); ctx.arc(mx, my, snapR, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      if (isPinching) {
        ctx.fillStyle = "rgba(16,185,129,0.18)";
        ctx.beginPath(); ctx.arc(mx, my, snapR * 0.55, 0, Math.PI * 2); ctx.fill();
      }
    }

    ctx.restore();
  }

  drawSpecsHUD() {
    if (this.viewMode !== "specs") return;
    const ctx = this.ctx;
    ctx.save();
    // Waveguide frame corners
    const pad = 10;
    const cornerLen = 18;
    ctx.strokeStyle = "rgba(56,189,248,0.55)";
    ctx.lineWidth = 1.4;
    const corners = [
      { x: pad, y: pad, dirs: [[1, 0], [0, 1]] },
      { x: this.w - pad, y: pad, dirs: [[-1, 0], [0, 1]] },
      { x: this.w - pad, y: this.h - pad, dirs: [[-1, 0], [0, -1]] },
      { x: pad, y: this.h - pad, dirs: [[1, 0], [0, -1]] },
    ];
    for (const c of corners) {
      for (const [dx, dy] of c.dirs) {
        ctx.beginPath();
        ctx.moveTo(c.x, c.y);
        ctx.lineTo(c.x + dx * cornerLen, c.y + dy * cornerLen);
        ctx.stroke();
      }
    }
    // Top info bar
    ctx.fillStyle = "rgba(9,13,22,0.55)";
    ctx.fillRect(pad, pad, this.w - pad * 2, 22);
    ctx.fillStyle = "rgba(56,189,248,0.95)";
    ctx.font = "700 10px JetBrains Mono, monospace";
    ctx.fillText("◆  SPECS AR  •  Optical See-Through  •  Waveguide HUD  •  6DoF", pad + 8, pad + 14);
    ctx.fillStyle = "rgba(16,185,129,0.9)";
    ctx.fillText("◉ HANDS-FREE", this.w - pad - 88, pad + 14);
    ctx.restore();
  }

  drawGroundShadow() {
    // Subtle ellipse under center
    const ctx = this.ctx;
    const c = this.project({ x: 0, y: -0.28, z: -0.22 });
    if (!c) return;
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, 90 * c.s, 22 * c.s, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  renderFrame(timestamp) {
    this.t = timestamp || 0;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);

    // Background vignette
    const bg = ctx.createRadialGradient(this.w / 2, this.h * 0.35, 0, this.w / 2, this.h * 0.35, this.w * 0.75);
    bg.addColorStop(0, "rgba(56,189,248,0.04)");
    bg.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.w, this.h);

    this.drawDeskGrid();
    this.drawGroundShadow();
    this.drawCurvedGuides();
    this.drawComfortCone();
    this.drawWindows();
    this.drawHands();
    this.drawSpecsHUD();
  }
}
