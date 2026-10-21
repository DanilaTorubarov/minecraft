import { useEffect, useRef, type CSSProperties } from 'react'
import lightWallpaperUrl from '../assets/asadal-stock-18.webp'
import nightWallpaperUrl from '../assets/night-park.webp'
import { lowPerformanceEnabled, subscribeLowPerformanceSetting, useLowPerformanceSetting } from '../lib/performanceSetting'

const VERTEX_SHADER = `
  attribute vec2 a_position;
  varying vec2 v_uv;

  void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`

const FRAGMENT_SHADER = `
  precision highp float;

  varying vec2 v_uv;
  uniform sampler2D u_image;
  uniform vec2 u_resolution;
  uniform vec2 u_image_resolution;
  uniform vec3 u_ripples[6];
  uniform vec2 u_pointer;
  uniform float u_time;
  uniform float u_dark;
  uniform float u_night;
  uniform float u_scene_offset;

  vec2 cover_uv(vec2 uv) {
    vec2 centered = uv - 0.5;
    float screen_aspect = u_resolution.x / u_resolution.y;
    float image_aspect = u_image_resolution.x / u_image_resolution.y;
    if (screen_aspect > image_aspect) {
      centered.y *= image_aspect / screen_aspect;
    } else {
      centered.x *= screen_aspect / image_aspect;
    }
    centered.y += u_scene_offset;
    return centered + 0.5;
  }

  void main() {
    const float TAU = 6.28318530718;
    float loop_progress = mod(u_time, 24.0) / 24.0;
    float loop_phase = loop_progress * TAU;
    float aspect = u_resolution.x / u_resolution.y;
    float water = 1.0 - smoothstep(0.30, 0.67, v_uv.y);
    vec2 parallax = (u_pointer - 0.5) * vec2(0.012, 0.007);
    vec2 distortion = vec2(
      sin(v_uv.y * 38.0 + loop_phase * 2.0) * 0.00165 +
      sin(v_uv.y * 81.0 - loop_phase) * 0.00072 +
      sin((v_uv.x + v_uv.y) * 29.0 + loop_phase * 3.0) * 0.00048,
      sin(v_uv.x * 27.0 - loop_phase * 2.0) * 0.00082 +
      cos(v_uv.x * 61.0 + loop_phase) * 0.00034
    ) * water;

    vec2 ambient_center = vec2(0.22 + sin(loop_phase) * 0.12, 0.17 + cos(loop_phase) * 0.015);
    vec2 ambient_delta = v_uv - ambient_center;
    ambient_delta.x *= aspect;
    float ambient_distance = length(ambient_delta);
    float ambient_radius = loop_progress * 0.52;
    float ambient_ring = sin((ambient_distance - ambient_radius) * 82.0);
    ambient_ring *= exp(-abs(ambient_distance - ambient_radius) * 27.0);
    ambient_ring *= sin(loop_progress * 3.14159265) * water;
    vec2 ambient_direction = ambient_delta / max(ambient_distance, 0.001);
    ambient_direction.x /= aspect;
    distortion += ambient_direction * ambient_ring * 0.0032;

    float ripple_light = 0.0;
    for (int index = 0; index < 6; index++) {
      vec3 ripple = u_ripples[index];
      vec2 delta = v_uv - ripple.xy;
      delta.x *= aspect;
      float distance_to_pointer = length(delta);
      float radius = ripple.z * 0.19;
      float ring = sin((distance_to_pointer - radius) * 105.0);
      ring *= exp(-abs(distance_to_pointer - radius) * 34.0);
      ring *= exp(-ripple.z * 0.72);
      vec2 direction = delta / max(distance_to_pointer, 0.001);
      direction.x /= aspect;
      float ripple_strength = mix(0.32, 1.0, water);
      distortion += direction * ring * 0.0125 * ripple_strength;
      ripple_light += ring * 0.068 * ripple_strength;
    }

    vec2 texture_uv = clamp(cover_uv(v_uv + distortion - parallax), 0.001, 0.999);
    float chroma = min(0.0032, length(distortion) * 0.22);
    vec3 color;
    color.r = texture2D(u_image, clamp(texture_uv + vec2(chroma, 0.0), 0.001, 0.999)).r;
    color.g = texture2D(u_image, texture_uv).g;
    color.b = texture2D(u_image, clamp(texture_uv - vec2(chroma, 0.0), 0.001, 0.999)).b;
    float caustic = sin(v_uv.x * 44.0 + loop_phase * 3.0) * sin(v_uv.y * 57.0 - loop_phase * 2.0);
    caustic += sin((v_uv.x - v_uv.y) * 73.0 - loop_phase) * 0.55;
    float sparkle = pow(max(0.0, sin(v_uv.x * 91.0 + loop_phase * 4.0) * sin(v_uv.y * 83.0 - loop_phase * 3.0)), 12.0);
    color += (caustic * 0.016 + sparkle * 0.055 + ripple_light + ambient_ring * 0.025) * water * vec3(0.62, 0.91, 1.0);

    vec2 sun_position = vec2(0.86 + sin(loop_phase) * 0.008, 0.82 + cos(loop_phase) * 0.004);
    vec2 sun_delta = (v_uv - sun_position) * vec2(aspect, 1.0);
    float sun_bloom = exp(-length(sun_delta) * 8.0);
    vec2 flare_position = mix(sun_position, vec2(0.5), 1.65);
    float lens_flare = exp(-length((v_uv - flare_position) * vec2(aspect, 1.0)) * 22.0);
    lens_flare += exp(-length((v_uv - mix(sun_position, vec2(0.5), 1.28)) * vec2(aspect, 1.0)) * 42.0) * 0.7;
    float shimmer = 0.72 + sin(loop_phase * 2.0) * 0.28;
    color += (sun_bloom * 0.09 + lens_flare * 0.045) * shimmer * mix(vec3(0.58, 0.84, 1.0), vec3(0.35, 0.62, 0.92), u_dark);

    // The night artwork is already dark; only the daylight scene needs the
    // Dark theme's dimming and desaturation.
    float dark_treatment = u_dark * (1.0 - u_night);
    float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(vec3(luminance), color, mix(1.0, 0.85, dark_treatment));
    color *= mix(1.0, 0.50, dark_treatment);
    color = mix(color, mix(vec3(0.71, 0.91, 0.98), vec3(0.05, 0.13, 0.22), u_dark), 0.055);

    gl_FragColor = vec4(color, 1.0);
  }
`

type Ripple = { x: number; y: number; startedAt: number }

type BubbleStyle = CSSProperties & {
  '--bubble-x': string
  '--bubble-size': string
  '--bubble-duration': string
  '--bubble-delay': string
  '--bubble-drift': string
  '--bubble-drift-mid': string
  '--bubble-opacity': string
  '--bubble-blur': string
}

const BUBBLES: BubbleStyle[] = Array.from({ length: 20 }, (_, index) => {
  const depth = (index * 7) % 11
  const duration = 15 + (index * 11) % 14
  const drift = -44 + ((index * 29) % 89)
  return {
    '--bubble-x': `${(index * 37 + 6) % 96}%`,
    '--bubble-size': `${(18 + depth * 4) * 5}px`,
    '--bubble-duration': `${duration}s`,
    '--bubble-delay': `${-((index * 5.7) % duration)}s`,
    '--bubble-drift': `${drift}px`,
    '--bubble-drift-mid': `${drift * -0.35}px`,
    '--bubble-opacity': `${0.42 + depth * 0.018}`,
    '--bubble-blur': `${depth < 2 ? 1 : depth > 8 ? 0.35 : 0}px`,
  }
})

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type)
  if (shader === null) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

export default function LiveWallpaper() {
  const [lowPerf] = useLowPerformanceSetting()
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvasNode = canvasRef.current
    if (canvasNode === null) return

    const context = canvasNode.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    })
    if (context === null) return
    const canvas: HTMLCanvasElement = canvasNode
    const gl: WebGLRenderingContext = context

    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
    if (vertexShader === null || fragmentShader === null) return

    const program = gl.createProgram()
    const buffer = gl.createBuffer()
    const texture = gl.createTexture()
    if (program === null || buffer === null || texture === null) return

    gl.attachShader(program, vertexShader)
    gl.attachShader(program, fragmentShader)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return
    gl.useProgram(program)

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    )
    const position = gl.getAttribLocation(program, 'a_position')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)

    const resolution = gl.getUniformLocation(program, 'u_resolution')
    const imageResolution = gl.getUniformLocation(program, 'u_image_resolution')
    const ripplesUniform = gl.getUniformLocation(program, 'u_ripples')
    const pointerUniform = gl.getUniformLocation(program, 'u_pointer')
    const timeUniform = gl.getUniformLocation(program, 'u_time')
    const darkUniform = gl.getUniformLocation(program, 'u_dark')
    const nightUniform = gl.getUniformLocation(program, 'u_night')
    const sceneOffset = gl.getUniformLocation(program, 'u_scene_offset')
    if (
      resolution === null || imageResolution === null || ripplesUniform === null || pointerUniform === null ||
      timeUniform === null || darkUniform === null || nightUniform === null || sceneOffset === null
    ) return

    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const lightImage = new Image()
    const nightImage = new Image()
    const ripples: Ripple[] = []
    const rippleData = new Float32Array(18)
    const pointerTarget = { x: 0.5, y: 0.5 }
    const pointerSmooth = { x: 0.5, y: 0.5 }
    let activeImage: HTMLImageElement | null = null
    let frame = 0
    let running = false
    let lastRippleAt = 0
    const startedAt = performance.now()

    const isNight = () => document.documentElement.dataset.theme === 'dark'
    const wantedImage = () => (isNight() ? nightImage : lightImage)
    const isLoaded = (image: HTMLImageElement) => image.naturalWidth > 0

    function bindTexture(image: HTMLImageElement) {
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
      activeImage = image
    }

    function syncTexture() {
      const wanted = wantedImage()
      if (isLoaded(wanted) && wanted !== activeImage) bindTexture(wanted)
    }

    function resize() {
      const cssWidth = Math.max(1, window.innerWidth)
      const cssHeight = Math.max(1, window.innerHeight)
      const pixelBudget = 2_600_000
      const budgetScale = Math.sqrt(pixelBudget / (cssWidth * cssHeight))
      const scale = Math.min(window.devicePixelRatio || 1, 1.6, budgetScale)
      const width = Math.round(cssWidth * scale)
      const height = Math.round(cssHeight * scale)
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
    }

    function addRipple(event: globalThis.PointerEvent) {
      if (lowPerformanceEnabled() || motionPreference.matches || document.visibilityState !== 'visible') return
      const now = performance.now()
      pointerTarget.x = event.clientX / Math.max(1, window.innerWidth)
      pointerTarget.y = 1 - event.clientY / Math.max(1, window.innerHeight)
      const interval = event.type === 'pointerdown' ? 0 : 54
      if (now - lastRippleAt < interval) return
      lastRippleAt = now
      ripples.unshift({
        x: pointerTarget.x,
        y: pointerTarget.y,
        startedAt: now,
      })
      ripples.splice(6)
    }

    function render(now: number) {
      running = true
      resize()
      syncTexture()
      if (activeImage === null) {
        running = false
        return
      }
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.uniform2f(resolution, canvas.width, canvas.height)
      gl.uniform2f(imageResolution, activeImage.naturalWidth, activeImage.naturalHeight)
      gl.uniform1f(timeUniform, (now - startedAt) / 1000)
      gl.uniform1f(darkUniform, isNight() ? 1 : 0)
      gl.uniform1f(nightUniform, activeImage === nightImage ? 1 : 0)
      // Shifting the night scene exposes its top edge as stretched columns.
      gl.uniform1f(sceneOffset, activeImage === nightImage ? 0 : 130 / Math.max(1, window.innerHeight))
      pointerSmooth.x += (pointerTarget.x - pointerSmooth.x) * 0.055
      pointerSmooth.y += (pointerTarget.y - pointerSmooth.y) * 0.055
      gl.uniform2f(pointerUniform, pointerSmooth.x, pointerSmooth.y)

      rippleData.fill(99)
      ripples.forEach((ripple, index) => {
        rippleData[index * 3] = ripple.x
        rippleData[index * 3 + 1] = ripple.y
        rippleData[index * 3 + 2] = (now - ripple.startedAt) / 1000
      })
      gl.uniform3fv(ripplesUniform, rippleData)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
      canvas.dataset.ready = 'true'
      frame = window.requestAnimationFrame(render)
    }

    function renderStatic() {
      resize()
      syncTexture()
      if (activeImage === null) return
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.uniform2f(resolution, canvas.width, canvas.height)
      gl.uniform2f(imageResolution, activeImage.naturalWidth, activeImage.naturalHeight)
      gl.uniform1f(timeUniform, 0)
      gl.uniform1f(darkUniform, isNight() ? 1 : 0)
      gl.uniform1f(nightUniform, activeImage === nightImage ? 1 : 0)
      gl.uniform1f(sceneOffset, activeImage === nightImage ? 0 : 130 / Math.max(1, window.innerHeight))
      gl.uniform2f(pointerUniform, 0.5, 0.5)
      rippleData.fill(99)
      gl.uniform3fv(ripplesUniform, rippleData)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
      canvas.dataset.ready = 'true'
    }

    function start() {
      if (running || motionPreference.matches || document.visibilityState !== 'visible') return
      if (!isLoaded(wantedImage())) return
      if (lowPerformanceEnabled()) {
        renderStatic()
        return
      }
      running = true
      frame = window.requestAnimationFrame(render)
    }

    function stop() {
      running = false
      window.cancelAnimationFrame(frame)
    }

    function syncPlayback() {
      stop()
      start()
    }

    function handleLoad() {
      syncPlayback()
    }

    lightImage.decoding = 'async'
    nightImage.decoding = 'async'
    lightImage.onload = handleLoad
    nightImage.onload = handleLoad
    lightImage.src = lightWallpaperUrl
    nightImage.src = nightWallpaperUrl

    const themeObserver = new MutationObserver(syncPlayback)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const unsubPerf = subscribeLowPerformanceSetting(syncPlayback)
    window.addEventListener('resize', syncPlayback, { passive: true })
    window.addEventListener('pointermove', addRipple, { passive: true })
    window.addEventListener('pointerdown', addRipple, { passive: true })
    document.addEventListener('visibilitychange', syncPlayback)
    motionPreference.addEventListener('change', syncPlayback)

    return () => {
      stop()
      themeObserver.disconnect()
      unsubPerf()
      window.removeEventListener('resize', syncPlayback)
      window.removeEventListener('pointermove', addRipple)
      window.removeEventListener('pointerdown', addRipple)
      document.removeEventListener('visibilitychange', syncPlayback)
      motionPreference.removeEventListener('change', syncPlayback)
      gl.deleteTexture(texture)
      gl.deleteBuffer(buffer)
      gl.deleteProgram(program)
      gl.deleteShader(vertexShader)
      gl.deleteShader(fragmentShader)
    }
  }, [])

  return (
    <div className="live-wallpaper" aria-hidden="true">
      <canvas ref={canvasRef} />
      {!lowPerf && (
        <>
          <span className="live-wallpaper-glow" />
          <span className="live-wallpaper-beams">
            <i />
            <i />
            <i />
          </span>
          <span className="live-wallpaper-particles">
            {BUBBLES.map((style, index) => <i className="wallpaper-bubble" key={index} style={style} />)}
          </span>
          <span className="live-wallpaper-glints">
            <i />
            <i />
            <i />
          </span>
        </>
      )}
    </div>
  )
}
