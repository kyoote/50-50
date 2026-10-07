(() => {
  'use strict';
  const canvas = document.getElementById('globe'), home = document.getElementById('home-screen');
  const toggle = document.getElementById('orbit-toggle'), world = window.GAME_DATA?.maps.world;
  if (!world) return;
  const texture = document.createElement('canvas');
  texture.width = 2048; texture.height = 1024;
  const paint = texture.getContext('2d');
  paint.fillStyle = '#183c50'; paint.fillRect(0, 0, 2048, 1024);
  paint.fillStyle = '#9bb5a3';
  for (const feature of world.features) {
    const geometry = feature.geometry;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    for (const polygon of polygons) {
      paint.beginPath();
      for (const ring of polygon) {
        ring.forEach(([lon, lat], i) => {
          const x = (lon + 180) / 360 * 2048, y = (90 - lat) / 180 * 1024;
          if (i) paint.lineTo(x, y); else paint.moveTo(x, y);
        });
        paint.closePath();
      }
      paint.fill('evenodd');
    }
  }
  let yaw = 135 * Math.PI / 180, pitch = .32, pointer = null, last = 0, resume = 0;
  let paused = matchMedia('(prefers-reduced-motion: reduce)').matches, dirty = true;
  let gl = canvas.getContext('webgl', {alpha: true, antialias: true, premultipliedAlpha: false});
  let program, camera, right, up, ctx, pixels, source;
  function shader(type, code) {
    const result = gl.createShader(type); gl.shaderSource(result, code); gl.compileShader(result);
    if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(result));
    return result;
  }
  if (gl) {
    program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, 'attribute vec2 position; varying vec2 screen; void main(){screen=position;gl_Position=vec4(position,0.,1.);}'));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `
      precision highp float;
      varying vec2 screen;
      uniform sampler2D earth;
      uniform vec3 camera, right, up;
      void main() {
        vec3 ray=normalize(right*screen.x+up*screen.y-camera*2.8);
        vec3 origin=camera*3.2;
        float b=dot(origin,ray), disc=b*b-9.24;
        if(disc<0.) {gl_FragColor=vec4(0.);return;}
        vec3 n=normalize(origin+ray*(-b-sqrt(disc)));
        vec2 uv=vec2(atan(n.z,n.x)/6.2831853+.5,.5-asin(clamp(n.y,-1.,1.))/3.14159265);
        vec3 color=texture2D(earth,uv).rgb;
        vec3 light=normalize(camera*.9-right*.5+up*.65);
        float shade=.34+.66*max(0.,dot(n,light));
        float rim=pow(1.-max(0.,dot(n,normalize(origin-n))),4.);
        color=color*shade+vec3(.13,.27,.32)*rim*.5;
        gl_FragColor=vec4(color,smoothstep(0.,.012,disc));
      }`));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const image = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, image);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    camera = gl.getUniformLocation(program, 'camera'); right = gl.getUniformLocation(program, 'right'); up = gl.getUniformLocation(program, 'up');
  } else {
    ctx = canvas.getContext('2d'); source = paint.getImageData(0, 0, 2048, 1024).data;
  }
  function resize() {
    const size = gl ? Math.min(1400, Math.round(canvas.clientWidth * Math.min(devicePixelRatio, 2))) : Math.min(320, canvas.clientWidth);
    if (!size || (size === canvas.width && (gl || pixels))) return;
    canvas.width = canvas.height = size;
    if (gl) gl.viewport(0, 0, size, size); else pixels = ctx.createImageData(size, size);
    dirty = true;
  }
  function draw() {
    const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
    const c = [cp*cy,sp,cp*sy], r = [-sy,0,cy], u = [-sp*cy,cp,-sp*sy];
    if (gl) {
      gl.uniform3fv(camera, c); gl.uniform3fv(right, r); gl.uniform3fv(up, u);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      return;
    }
    if (!pixels) return;
    const size = canvas.width, data = pixels.data;
    data.fill(0);
    for (let y=0; y<size; y++) for (let x=0; x<size; x++) {
      const sx = (x+.5)/size*2-1, sy = 1-(y+.5)/size*2, length = Math.hypot(sx,sy,2.8);
      const b = -8.96/length, disc = b*b-9.24;
      if (disc < 0) continue;
      const t = -b-Math.sqrt(disc);
      const n = c.map((v,i) => 3.2*v+(r[i]*sx+u[i]*sy-v*2.8)/length*t);
      const tx = Math.min(2047,Math.floor((Math.atan2(n[2],n[0])/Math.PI/2+.5)*2048));
      const ty = Math.min(1023,Math.floor((.5-Math.asin(Math.max(-1,Math.min(1,n[1])))/Math.PI)*1024));
      const dot = n.reduce((sum,v,i)=>sum+v*(c[i]*.9-r[i]*.5+u[i]*.65),0)/Math.hypot(.9,.5,.65);
      const shade = .34+.66*Math.max(0,dot), at=(y*size+x)*4, from=(ty*2048+tx)*4;
      for(let i=0;i<3;i++) data[at+i]=source[from+i]*shade;
      data[at+3]=255;
    }
    ctx.putImageData(pixels,0,0);
  }
  function updateToggle() {
    toggle.textContent = paused ? '▶' : 'Ⅱ';
    toggle.setAttribute('aria-label', paused ? '地球の自動周回を再開' : '地球の自動周回を停止');
    toggle.setAttribute('aria-pressed', String(paused));
  }
  toggle.addEventListener('click', () => {paused=!paused; updateToggle();});
  canvas.addEventListener('pointerdown', event => {
    if (pointer || (event.pointerType === 'mouse' && event.button !== 0)) return;
    pointer = {id:event.pointerId,x:event.clientX,y:event.clientY};
    canvas.setPointerCapture(event.pointerId); canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', event => {
    if (!pointer || pointer.id !== event.pointerId) return;
    yaw -= (event.clientX-pointer.x)/canvas.clientWidth*3;
    pitch = Math.max(-1.2,Math.min(1.2,pitch+(event.clientY-pointer.y)/canvas.clientWidth*3));
    pointer.x=event.clientX; pointer.y=event.clientY; dirty=true;
  });
  for (const event of ['pointerup','pointercancel','lostpointercapture']) canvas.addEventListener(event, () => {
    pointer=null; resume=performance.now(); canvas.classList.remove('dragging');
  });
  canvas.addEventListener('keydown', event => {
    if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'ArrowLeft') yaw-=.12;
    if (event.key === 'ArrowRight') yaw+=.12;
    if (event.key === 'ArrowUp') pitch=Math.min(1.2,pitch+.12);
    if (event.key === 'ArrowDown') pitch=Math.max(-1.2,pitch-.12);
    resume=performance.now(); dirty=true;
  });
  function frame(now) {
    requestAnimationFrame(frame);
    if (home.hidden || document.hidden || document.querySelector('dialog[open]')) {last=now;return;}
    const delta=Math.min(100,now-last);
    if (delta < (gl ? 30 : 65)) return;
    last=now;
    if (!paused && !pointer) {yaw=(yaw+delta*Math.PI*2/30000*Math.min(1,(now-resume)/1200))%(Math.PI*2);dirty=true;}
    if (dirty) {resize();draw();dirty=false;}
  }
  new ResizeObserver(resize).observe(canvas);
  canvas.addEventListener('webglcontextlost', event => {event.preventDefault();paused=true;updateToggle();});
  canvas.addEventListener('webglcontextrestored', () => location.reload());
  updateToggle(); resize(); requestAnimationFrame(frame);
})();
