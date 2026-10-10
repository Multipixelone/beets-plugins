import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const VERSION = '3.4.2';
const SHA256 = '4ad56e0d6ddb6ad483baee7464b6ab0dd88b31c6af7f049408ad50574b8f1ff2';

function replaceOnce(source, before, after) {
  const index = source.indexOf(before);
  if (index < 0 || source.indexOf(before, index + before.length) >= 0) {
    throw new Error(`Expected one Cosmos renderer patch location: ${before.slice(0, 90)}`);
  }
  return source.slice(0, index) + after + source.slice(index + before.length);
}

function patchSection(source, startMarker, endMarker, patch) {
  const start = source.indexOf(startMarker), end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`Missing Cosmos renderer section: ${startMarker}`);
  return source.slice(0, start) + patch(source.slice(start, end)) + source.slice(end);
}

// Gather uses the existing once-per-tick gravity pass for a soft annular force.
// Background albums keep their native springs, collisions and drag behavior;
// no full position readback or second simulation is needed.
function patchAlbumOrbit(source) {
  source = patchSection(source, 'const Ht = `', '`;', shader => {
    shader = replaceOnce(shader, 'uniform sampler2D positionsTexture;',
      'uniform sampler2D positionsTexture;\nuniform sampler2D pinnedStatusTexture;');
    shader = replaceOnce(shader, '  float alpha;\n} forceGravity;',
      '  float alpha;\n  vec4 albumOrbitGeometry;\n  vec4 albumOrbitMotion;\n} forceGravity;');
    shader = replaceOnce(shader, '#define alpha forceGravity.alpha',
      '#define alpha forceGravity.alpha\n#define albumOrbitGeometry forceGravity.albumOrbitGeometry\n#define albumOrbitMotion forceGravity.albumOrbitMotion');
    shader = replaceOnce(shader, 'uniform float alpha;\n#endif',
      'uniform float alpha;\nuniform vec4 albumOrbitGeometry;\nuniform vec4 albumOrbitMotion;\n#endif');
    return replaceOnce(shader, '  vec4 velocity = vec4(0.0);', `  vec4 velocity = vec4(0.0);
  if (albumOrbitMotion.x > 0.0) {
    // Hidden points retain NaN coordinates. Pinned matches and the album under
    // the pointer are controlled elsewhere, so never add orbit forces to them.
    float index = pointPosition.b;
    if (any(isnan(pointPosition.rg)) || any(isinf(pointPosition.rg)) ||
        texelFetch(pinnedStatusTexture, pointTexel, 0).r > 0.5 ||
        index == albumOrbitMotion.w) {
      fragColor = velocity;
      return;
    }
    vec2 offset = pointPosition.rg - albumOrbitGeometry.xy;
    float distance = length(offset);
    float seed = fract(sin((index + 1.0) * 12.9898) * 43758.5453);
    float angle = seed * 6.28318530718;
    vec2 radial = distance > 0.001 ? offset / distance : vec2(cos(angle), sin(angle));
    float innerRadius = albumOrbitGeometry.z;
    float outerRadius = albumOrbitGeometry.w;
    // Spread equilibrium radii over annular area instead of collapsing every
    // background album onto the same circumference.
    float target = sqrt(mix(innerRadius * innerRadius, outerRadius * outerRadius, 0.15 + 0.7 * seed));
    float correction = (target - distance) * 0.12;
    correction += max(0.0, innerRadius - distance);
    correction -= max(0.0, distance - outerRadius);
    float limit = max(2.0, outerRadius * 0.025);
    float pull = clamp(correction * albumOrbitMotion.z, -limit, limit);
    velocity.rg = radial * pull + vec2(-radial.y, radial.x) *
      max(distance, innerRadius) * albumOrbitMotion.y;
    fragColor = velocity;
    return;
  }`);
  });
  source = patchSection(source, 'class we extends V {', '\nfunction Xt(', gravity => {
    gravity = replaceOnce(gravity, '          alpha: "f32"',
      '          alpha: "f32",\n          albumOrbitGeometry: "vec4<f32>",\n          albumOrbitMotion: "vec4<f32>"');
    gravity = replaceOnce(gravity, 'if (!t || !this.runCommand',
      'if (!t || !t.pinnedStatusTexture || t.pinnedStatusTexture.destroyed || !this.runCommand');
    gravity = replaceOnce(gravity, '    this.uniformStore.setUniforms({', `    const orbit = this.data.albumOrbit, now = performance.now();
    const elapsed = Math.min(1 / 30, Math.max(0, (now - (this.albumOrbitTime ?? now - 1000 / 60)) / 1000));
    this.albumOrbitTime = orbit ? now : undefined;
    this.uniformStore.setUniforms({`);
    gravity = replaceOnce(gravity, '        alpha: i.alpha', `        alpha: i.alpha,
        albumOrbitGeometry: orbit ? [...orbit.center, orbit.innerRadius, orbit.outerRadius] : [0, 0, 0, 0],
        albumOrbitMotion: orbit ? [1, orbit.speed * elapsed * 2, orbit.strength * elapsed * 60,
          i.draggingPointIndex ?? -1] : [0, 0, 0, -1]`);
    return replaceOnce(gravity, '      positionsTexture: t.previousPositionTexture',
      '      positionsTexture: t.previousPositionTexture,\n      pinnedStatusTexture: t.pinnedStatusTexture');
  });
  return replaceOnce(source, '&& (t && ((c = this.points)',
    '&& ((t || this.graph.albumOrbit) && ((c = this.points)');
}

// GL_POINTS silently clips cover growth to the device's ALIASED_POINT_SIZE_RANGE.
// Use four-vertex instances for both drawing and picking. They
// sample the same GPU positions, uniforms and atlas, so camera motion does not
// involve CPU position readbacks, physics changes or a second visual layer.
function patchAlbumQuads(source) {
  source = patchSection(source, 'Me = `', '`', shader => {
    shader = replaceOnce(shader, 'in vec2 pointIndices;', 'in vec2 albumCorner;\nin vec2 pointIndices;');
    shader = replaceOnce(shader, 'out float pointShape;', 'out vec2 albumPointCoord;\nout float pointShape;');
    const imageSize = '  float imageSizeValue = hasImage ? calculatePointSize(imageSize * sizeScale) : 0.0;';
    shader = replaceOnce(shader, imageSize, `${imageSize}\n  shapeSizeValue = albumFrameSizePx(shapeSizeValue, imageSizeValue, shape, hasImage, ratio);`);
    shader = replaceOnce(shader,
      '  overallSizeValue = min(overallSizeValue, maxPointSize * ratio);',
      '  // Instanced quads have no hardware point-size ceiling.');
    return replaceOnce(shader, '  gl_PointSize = overallSizeValue;', `  vec2 corner = albumCorner;
  albumPointCoord = vec2(corner.x, -corner.y) * 0.5 + 0.5;
  gl_Position.xy += corner * overallSizeValue / (screenSize * ratio);`);
  });
  source = patchSection(source, 'Ue = `', '`', shader =>
    replaceOnce(replaceOnce(shader, 'in float pointShape;', 'in vec2 albumPointCoord;\nin float pointShape;'),
      'gl_PointCoord', 'albumPointCoord'));
  source = patchSection(source, 'bi = `', '`', shader => {
    shader = replaceOnce(shader, 'in vec2 pointIndices;', 'in vec2 albumCorner;\nin vec2 pointIndices;');
    shader = replaceOnce(shader, 'in float size;', 'in float size;\nin float shape;');
    shader = replaceOnce(shader, 'out vec4 rgba;', 'out vec4 rgba;\nout vec2 albumPointCoord;\nflat out float albumSquare;');
    const imageSize = '  float imageSizeValue = hasImage ? calculatePointSize(imageSize * sizeScale, pxPerUnit) : 0.0;';
    shader = replaceOnce(shader, imageSize, `${imageSize}\n  shapeSizeValue = albumFrameSizePx(shapeSizeValue, imageSizeValue, shape, hasImage, ratio);`);
    shader = replaceOnce(shader, '  float spriteSize = max(shapeSizeValue, imageSizeValue) / ratio * pickingPixelRatio;',
      `  albumSquare = (shape == 1.0 || hasImage) ? 1.0 : 0.0;
  float shapeFootprint = shapeSizeValue * (shape == 1.0 ? 0.8 : 1.0);
  float spriteSize = max(shapeFootprint, imageSizeValue) / ratio * pickingPixelRatio;`);
    return replaceOnce(shader, '  gl_Position = vec4(ndc, 0.0, 1.0);', `  vec2 corner = albumCorner;
  albumPointCoord = corner * 0.5 + 0.5;
  gl_Position = vec4(ndc + corner * max(spriteSize, minPickingSize) / (screenSize * pickingPixelRatio), 0.0, 1.0);`);
  });
  source = patchSection(source, 'ki = `', '`', shader => {
    shader = replaceOnce(shader, 'in vec4 rgba;', 'in vec4 rgba;\nin vec2 albumPointCoord;\nflat in float albumSquare;');
    shader = replaceOnce(shader, 'gl_PointCoord', 'albumPointCoord');
    return replaceOnce(shader, 'if (dot(fromCenter, fromCenter) > 1.0) discard;',
      'if (albumSquare < 0.5 && dot(fromCenter, fromCenter) > 1.0) discard;');
  });
  // The shared rule also controls selection bounds and the existing quad ring.
  source = replaceOnce(source, 'return min(size * ratio * zoom, maxPointSize * ratio);',
    'return size * ratio * zoom;');
  source = patchSection(source, 'Ne = `', '`', shader => `${shader}
// Artwork grows continuously. Its colored frame adds at most 4 CSS pixels
// across the square (2 per side); changing this visual trim never moves albums.
// Cosmos squares occupy 80% of shape size. Drawing and picking share the rule.
float albumFrameSizePx(float shapeSize, float imageSize, float shape, bool hasImage, float ratio) {
  return hasImage && shape == 1.0 ? min(shapeSize, (imageSize + 4.0 * ratio) / 0.8) : shapeSize;
}
`);
  source = replaceOnce(source, 'Math.min(Math.max(s, 1 / i), n) / 2', 'Math.max(s, 1 / i) / 2');
  for (const command of ['drawCommand', 'drawCoreCommand', 'fillPickingBufferCommand']) {
    source = patchSection(source, `this.${command} = new k(e, {`, '\n    }))', model => {
      model = replaceOnce(model, 'topology: "point-list"', 'topology: "triangle-strip"');
      model = replaceOnce(model, 'vertexCount: n.pointsNumber ?? 0,', 'vertexCount: 4,\n      instanceCount: n.pointsNumber ?? 0,');
      model = model.replace(/format: "(float32(?:x[24])?)"/g, 'format: "$1", stepMode: "instance"');
      // WebGL requires an active divisor-zero attribute for instanced draws.
      // Reuse the existing, lifetime-managed [-1,1] quad corner buffer.
      model = replaceOnce(model, '      attributes: {', '      attributes: {\n        albumCorner: this.dragPointVertexCoordBuffer,');
      model = replaceOnce(model, '      bufferLayout: [', '      bufferLayout: [\n        { name: "albumCorner", format: "float32x2", stepMode: "vertex" },');
      if (command === 'drawCoreCommand') {
        // The same depth-encoded core/fringe passes remain correct in forward
        // instance order. Element indices would index quad corners, not albums.
        model = replaceOnce(model, '      indexBuffer: this.reversedPointIndexBuffer ?? null,\n', '');
      }
      if (command === 'fillPickingBufferCommand') {
        model = replaceOnce(model, '      attributes: {', '      attributes: {\n        ...this.shapeBuffer && { shape: this.shapeBuffer },');
        model = replaceOnce(model, '      bufferLayout: [', '      bufferLayout: [\n        { name: "shape", format: "float32", stepMode: "instance" },');
      }
      return model;
    });
  }
  source = replaceOnce(source, 'r.setIndexBuffer(this.reversedPointIndexBuffer)', 'r.setIndexBuffer(null)');
  source = replaceOnce(source, 'this.drawCommand.setVertexCount(t.pointsNumber)', 'this.drawCommand.setInstanceCount(t.pointsNumber)');
  source = replaceOnce(source, 'this.drawCoreCommand.setVertexCount(t.pointsNumber)', 'this.drawCoreCommand.setInstanceCount(t.pointsNumber)');
  source = replaceOnce(source, 'this.fillPickingBufferCommand.setVertexCount(this.data.pointsNumber ?? 0)',
    'this.fillPickingBufferCommand.setInstanceCount(this.data.pointsNumber ?? 0)');
  source = replaceOnce(source, 'this.fillPickingBufferCommand.setAttributes({\n      ...this.hoveredPointIndices',
    'this.fillPickingBufferCommand.setAttributes({\n      ...this.shapeBuffer && { shape: this.shapeBuffer },\n      ...this.hoveredPointIndices');
  // Adapter-local hook: native onSimulationTick precedes tracked-position
  // updates. Labels need the positions and camera from the just-drawn frame.
  source = replaceOnce(source, 'onSimulationTick: void 0,', 'onSimulationTick: void 0,\n  onRenderFrame: void 0,');
  source = patchSection(source, '  renderFrame(e) {', '\n  stopFrames()', frame => {
    const drag = 'this.dragInstance.isActive && ((v = this.points) == null || v.swapFbo(), (C = this.points) == null || C.drag(), (g = this.points) == null || g.trackPoints(), this.markPickingBuffersStale())';
    // Update dragging before rendering so the drawn pixels, tracked anchors
    // and callback all refer to this frame, rather than adjacent frames.
    frame = replaceOnce(frame, `, ${drag}, L.end()`, ', L.end()');
    return replaceOnce(frame, '      F !== !1', `      ${drag}, F !== !1`);
  });
  source = replaceOnce(source, 'L.end(), this.device.submit();',
    'L.end(), this.device.submit(), this.config.onRenderFrame?.();');
  return source;
}

export function patchCosmosAtlas(source, version, atlasPath) {
  if (version !== VERSION || createHash('sha256').update(source).digest('hex') !== SHA256) {
    throw new Error('Cosmos atlas patch requires the exact pinned @cosmos.gl/graph 3.4.2 bundle; review the adapter before upgrading');
  }
  const start = source.indexOf('function Ai(a, e = 16384) {');
  const end = source.indexOf('\nfunction Bi(', start);
  if (start < 0 || end < 0 || source.indexOf('function Ai(a, e = 16384) {', start + 1) >= 0) {
    throw new Error('Expected exactly one Cosmos 3.4.2 atlas helper');
  }
  let patched = source.slice(0, start) + 'function Ai(a, e = 16384) { return albumAtlas(a, e); }\n' + source.slice(end);
  const replace = (before, after, count = 1) => {
    if (patched.split(before).length - 1 !== count) throw new Error(`Unexpected Cosmos adapter site: ${before}`);
    patched = patched.replaceAll(before, after);
  };
  // A cover's alpha must inherit the album alpha, without blending its RGB
  // with the group frame. Brightness follows the same salience curve as alpha.
  replace('float renderMode;\n} drawFragment;', 'float renderMode;\n  float albumVibeActive;\n} drawFragment;');
  replace('#define renderMode drawFragment.renderMode', '#define renderMode drawFragment.renderMode\n#define albumVibeActive drawFragment.albumVibeActive');
  replace('uniform float renderMode;\n#endif', 'uniform float renderMode;\nuniform float albumVibeActive;\n#endif');
  replace('renderMode: "f32"\n        }', 'renderMode: "f32",\n          albumVibeActive: "f32"\n        }');
  replace('renderMode: 0\n        }', 'renderMode: 0,\n          albumVibeActive: t.albumVibeActive ? 1 : 0\n        }');
  replace('renderMode: 0\n    }, r =', 'renderMode: 0,\n      albumVibeActive: i.albumVibeActive ? 1 : 0\n    }, r =');
  replace('float finalPointAlpha = max(finalShapeColor.a, finalImageColor.a);',
    'float finalPointAlpha = max(finalShapeColor.a, finalImageColor.a * shapeColor.a);');
  replace('mix(finalShapeColor.rgb, finalImageColor.rgb, finalImageColor.a),',
    'clamp(mix(finalShapeColor.rgb, finalImageColor.rgb, finalImageColor.a) *\n' +
    '          (albumVibeActive > 0.5 && shapeColor.a >= 0.6999 ?\n' +
    '           1.05 + 0.2 * clamp((shapeColor.a - 0.7) / 0.3, 0.0, 1.0) : 1.0), 0.0, 1.0),');
  // Only collision-grid consumers use the baseline sizes. Picking and drawing
  // continue to use the larger visual footprint.
  replace('s = Math.max(s, i.getResolvedPointSize(p))', 's = Math.max(s, i.albumCollisionSizes?.[p] ?? i.getResolvedPointSize(p))');
  replace('l[p * 4] = i.getResolvedPointSize(p)', 'l[p * 4] = i.albumCollisionSizes?.[p] ?? i.getResolvedPointSize(p)');
  // Only centroid reductions see the original anchors. Repulsion/collision and
  // rendering still see the temporary comparison positions.
  replace('this.calculateCentermassCommand.setBindings({\n      positionsTexture: i.previousPositionTexture,',
    'this.calculateCentermassCommand.setBindings({\n      positionsTexture: i.albumAttractionPositions?.() ?? i.previousPositionTexture,');
  replace('clusterTexture: this.clusterTexture,\n      positionsTexture: t.previousPositionTexture,',
    'clusterTexture: this.clusterTexture,\n      positionsTexture: t.albumAttractionPositions?.() ?? t.previousPositionTexture,');
  // Drag copies every position texel, including albums that aren't dragged.
  // The default sampler precision quantizes their float coordinates on real
  // GPUs even while physics is paused. Preserve the frozen timeline baseline.
  patched = patchSection(patched, ', Di = `', '`;', shader =>
    replaceOnce(shader, 'uniform sampler2D positionsTexture;', 'uniform highp sampler2D positionsTexture;'));
  return `import { createAtlasDataFromImageData as albumAtlas } from ${JSON.stringify(atlasPath)};\n` +
    patchAlbumQuads(patchAlbumOrbit(patched));
}

export const cosmosAtlasPlugin = {
  name: 'bounded-cosmos-3.4.2-album-renderer',
  setup(build) {
    build.onLoad({ filter: /@cosmos\.gl[\\/]graph[\\/]dist[\\/]index\.js$/ }, async ({ path }) => {
      const pkg = JSON.parse(await readFile(resolve(dirname(path), '../package.json'), 'utf8'));
      return { contents: patchCosmosAtlas(await readFile(path, 'utf8'), pkg.version,
        resolve('atlas.mjs')), loader: 'js', resolveDir: dirname(path) };
    });
  },
};
