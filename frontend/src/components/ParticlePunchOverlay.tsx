import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react'
import * as THREE from 'three'

import { PUNCH_SFX_ENABLED } from '../lib/punchSfxConfig'

export type ParticlePunchHandle = {
  /** Clip space XY ∈ [-1,1], Y up（与 Three Raycaster 一致） */
  tryPunch: (ndc: { x: number; y: number }) => boolean
  /** 将本轮输入拆成粒子：中文单字一颗，英文/数字连续为单词一颗（可多次调用叠加） */
  appendUserTextParticles: (text: string) => void
}

type Props = {
  /** 蒙层可见（仍可接收 tryPunch） */
  visible: boolean
  /** 每次有效击打（球体开始爆散） */
  onSuccessfulHit?: () => void
}

const SPHERE_R = 1.12
const COLLIDER_R = 1.34
/** 用户文字精灵高度（世界单位），略大便于读 */
const USER_SPRITE_BASE_H_CJK = 0.175
const USER_SPRITE_BASE_H_WORD = 0.138
const WIDTH_SEG = 52
const HEIGHT_SEG = 38

function fract(n: number) {
  return n - Math.floor(n)
}

function hash01(i: number, salt: number) {
  return fract(Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453)
}

function classifyVertex(i: number, total: number):
  | 'dot'
  | 't1'
  | 't2'
  | 'at'
  | 'amp'
  | 'pct' {
  const u = hash01(i, total)
  if (u < 0.012) return 't1'
  if (u < 0.024) return 't2'
  if (u < 0.032) return 'at'
  if (u < 0.04) return 'amp'
  if (u < 0.048) return 'pct'
  return 'dot'
}

function makeSoftDotTexture(): THREE.CanvasTexture {
  const s = 64
  const c = document.createElement('canvas')
  c.width = s
  c.height = s
  const g = c.getContext('2d')!
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  grd.addColorStop(0, 'rgba(255,255,255,1)')
  grd.addColorStop(0.35, 'rgba(255,255,255,0.45)')
  grd.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, s, s)
  const t = new THREE.CanvasTexture(c)
  t.needsUpdate = true
  return t
}

/** 球面装饰用单字符（@ & %） */
function makeCharTexture(ch: string): THREE.CanvasTexture {
  const s = 128
  const c = document.createElement('canvas')
  c.width = s
  c.height = s
  const g = c.getContext('2d')!
  g.clearRect(0, 0, s, s)
  const isCjk = /[\u4e00-\u9fff\u3400-\u4dbf]/u.test(ch)
  g.font = isCjk
    ? '600 80px "Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", ui-sans-serif, sans-serif'
    : 'bold 82px "IBM Plex Mono", "Space Mono", ui-monospace, monospace'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillStyle = '#ffffff'
  g.fillText(ch, s / 2, s / 2 + 4)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.needsUpdate = true
  return t
}

const CJK_RANGE_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/u

/** 中文逐字，英文/数字连续段为单词（撇号可与字母同属一词，如 don't） */
function tokenizeForParticles(fragment: string): string[] {
  const s = fragment.normalize('NFC')
  const tokens: string[] = []
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (/\s/u.test(ch)) {
      i++
      continue
    }
    if (CJK_RANGE_RE.test(ch)) {
      tokens.push(ch)
      i++
      continue
    }
    if (/[A-Za-z0-9]/.test(ch)) {
      const start = i
      i++
      while (i < s.length) {
        const c = s[i]
        if (/[A-Za-z0-9]/.test(c)) {
          i++
          continue
        }
        if (c === "'" && i + 1 < s.length && /[A-Za-z]/.test(s[i + 1])) {
          i++
          continue
        }
        break
      }
      tokens.push(s.slice(start, i))
      continue
    }
    i++
  }
  return tokens
}

const latinFont = (px: number) =>
  `bold ${px}px "IBM Plex Mono", "Space Mono", ui-monospace, monospace`

/** 用户粒子贴图：单字 CJK、单词用横向画布 */
function makeUserParticleTexture(token: string): THREE.CanvasTexture {
  const singleCjk =
    token.length === 1 && CJK_RANGE_RE.test(token)

  if (singleCjk) {
    const s = 128
    const c = document.createElement('canvas')
    c.width = s
    c.height = s
    const g = c.getContext('2d')!
    g.clearRect(0, 0, s, s)
    g.font =
      '600 90px "Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", ui-sans-serif, sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillStyle = '#ffffff'
    g.fillText(token, s / 2, s / 2 + 4)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    t.needsUpdate = true
    return t
  }

  const singleAscii =
    token.length === 1 && !CJK_RANGE_RE.test(token)
  if (singleAscii) {
    const s = 128
    const c = document.createElement('canvas')
    c.width = s
    c.height = s
    const g = c.getContext('2d')!
    g.clearRect(0, 0, s, s)
    g.font = latinFont(92)
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillStyle = '#ffffff'
    g.fillText(token, s / 2, s / 2 + 4)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    t.needsUpdate = true
    return t
  }

  const pad = 20
  const maxCanvasW = 720
  const h = 128
  let fontPx = 80
  const measureCv = document.createElement('canvas')
  const mg = measureCv.getContext('2d')!
  let outW = 128

  while (fontPx >= 24) {
    mg.font = latinFont(fontPx)
    const tw = mg.measureText(token).width + pad * 2
    if (tw <= maxCanvasW) {
      outW = Math.max(128, Math.ceil(tw))
      break
    }
    fontPx -= 3
  }
  if (fontPx < 24) {
    fontPx = 24
    mg.font = latinFont(fontPx)
    outW = maxCanvasW
  }

  const c = document.createElement('canvas')
  c.width = outW
  c.height = h
  const g = c.getContext('2d')!
  g.clearRect(0, 0, outW, h)
  g.font = latinFont(fontPx)
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillStyle = '#ffffff'
  g.fillText(token, outW / 2, h / 2 + 3)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.needsUpdate = true
  return t
}

function scaleForUserSprite(tex: THREE.CanvasTexture, isCjkSingle: boolean) {
  const img = tex.image as HTMLCanvasElement
  const aspect = img.width / Math.max(1, img.height)
  const baseH = isCjkSingle ? USER_SPRITE_BASE_H_CJK : USER_SPRITE_BASE_H_WORD
  const baseW = baseH * aspect
  return { baseW, baseH }
}

function randomPointOnSphere(radius: number): THREE.Vector3 {
  const u = Math.random()
  const v = Math.random()
  const theta = 2 * Math.PI * u
  const phi = Math.acos(2 * v - 1)
  return new THREE.Vector3(
    radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.sin(phi) * Math.sin(theta),
    radius * Math.cos(phi),
  )
}

function playPunchSfx() {
  if (!PUNCH_SFX_ENABLED) return
  try {
    const a = new Audio('/bass-808-shot-bomboclat_C_major.wav')
    a.volume = 0.72
    void a.play()
  } catch {
    /* ignore */
  }
}

export const ParticlePunchOverlay = forwardRef<ParticlePunchHandle, Props>(
  function ParticlePunchOverlay({ visible, onSuccessfulHit }, ref) {
    const mountRef = useRef<HTMLDivElement>(null)
    const visibleRef = useRef(visible)
    const onHitRef = useRef(onSuccessfulHit)
    visibleRef.current = visible
    onHitRef.current = onSuccessfulHit

    const apiRef = useRef({
      tryPunch: (_ndc: { x: number; y: number }) => false as boolean,
      appendUserTextParticles: (_text: string) => {
        /* replaced in effect */
      },
    })

    useImperativeHandle(ref, () => ({
      tryPunch: (ndc) => apiRef.current.tryPunch(ndc),
      appendUserTextParticles: (text) =>
        apiRef.current.appendUserTextParticles(text),
    }))

    useEffect(() => {
      const mount = mountRef.current
      if (!mount) return

      const scene = new THREE.Scene()
      scene.background = null

      const camera = new THREE.PerspectiveCamera(42, 1, 0.08, 80)
      camera.position.z = 4.85

      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance',
      })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      renderer.setClearColor(0x000000, 0)
      mount.appendChild(renderer.domElement)

      const flashLayer = document.createElement('div')
      flashLayer.className = 'particle-punch-hit-flash'
      flashLayer.setAttribute('aria-hidden', 'true')
      mount.appendChild(flashLayer)

      const triggerHitFlash = () => {
        flashLayer.classList.remove('is-active')
        requestAnimationFrame(() => {
          flashLayer.classList.add('is-active')
        })
      }

      const collider = new THREE.Mesh(
        new THREE.SphereGeometry(COLLIDER_R, 20, 16),
        new THREE.MeshBasicMaterial({ visible: false }),
      )
      scene.add(collider)

      const root = new THREE.Group()
      scene.add(root)

      const raycaster = new THREE.Raycaster()

      const sphereGeom = new THREE.SphereGeometry(
        SPHERE_R,
        WIDTH_SEG,
        HEIGHT_SEG,
      )
      const posAttr = sphereGeom.attributes.position as THREE.BufferAttribute
      const vc = posAttr.count

      const dotIdx: number[] = []
      const spec: { vi: number; kind: 't1' | 't2' | 'at' | 'amp' | 'pct' }[] =
        []
      for (let i = 0; i < vc; i++) {
        const c = classifyVertex(i, vc)
        if (c === 'dot') dotIdx.push(i)
        else if (c === 't1') spec.push({ vi: i, kind: 't1' })
        else if (c === 't2') spec.push({ vi: i, kind: 't2' })
        else if (c === 'at') spec.push({ vi: i, kind: 'at' })
        else if (c === 'amp') spec.push({ vi: i, kind: 'amp' })
        else spec.push({ vi: i, kind: 'pct' })
      }

      const dotPos = new Float32Array(dotIdx.length * 3)
      const baseDot = new Float32Array(dotIdx.length * 3)
      for (let j = 0; j < dotIdx.length; j++) {
        const vi = dotIdx[j]
        const x = posAttr.getX(vi)
        const y = posAttr.getY(vi)
        const z = posAttr.getZ(vi)
        baseDot[j * 3] = x
        baseDot[j * 3 + 1] = y
        baseDot[j * 3 + 2] = z
        dotPos[j * 3] = x
        dotPos[j * 3 + 1] = y
        dotPos[j * 3 + 2] = z
      }

      const dotTexture = makeSoftDotTexture()
      const dotGeo = new THREE.BufferGeometry()
      dotGeo.setAttribute('position', new THREE.BufferAttribute(dotPos, 3))

      const dotsMat = new THREE.PointsMaterial({
        map: dotTexture,
        color: 0xffffff,
        size: 0.042,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
        blending: THREE.NormalBlending,
        vertexColors: false,
      })
      const dotPoints = new THREE.Points(dotGeo, dotsMat)
      root.add(dotPoints)

      const charTex = {
        hash: makeCharTexture('#'),
        at: makeCharTexture('@'),
        amp: makeCharTexture('&'),
        pct: makeCharTexture('%'),
      }

      const spriteList: {
        spr: THREE.Sprite
        base: THREE.Vector3
        kind: string
        /** 重建缩放用（user 与装饰粒共用；装饰为正方形） */
        baseScaleX: number
        baseScaleY: number
      }[] = []

      function texFor(k: string) {
        if (k === 't1') return charTex.at
        if (k === 't2') return charTex.hash
        if (k === 'at') return charTex.at
        if (k === 'amp') return charTex.amp
        return charTex.pct
      }

      for (const s of spec) {
        const vi = s.vi
        const v = new THREE.Vector3(
          posAttr.getX(vi),
          posAttr.getY(vi),
          posAttr.getZ(vi),
        )
        const mat = new THREE.SpriteMaterial({
          map: texFor(s.kind),
          transparent: true,
          opacity: 0.94,
          depthWrite: false,
          blending: THREE.NormalBlending,
        })
        const spr = new THREE.Sprite(mat)
        const sc =
          s.kind === 't1' || s.kind === 't2' ? 0.11 : 0.085
        spr.scale.set(sc, sc, sc)
        spr.position.copy(v)
        root.add(spr)
        spriteList.push({
          spr,
          base: v.clone(),
          kind: s.kind,
          baseScaleX: sc,
          baseScaleY: sc,
        })
      }

      const baseSpriteCount = spriteList.length
      const MAX_USER_SPRITES = 120
      const MAX_USER_TOKENS_PER_APPEND = 36

      sphereGeom.dispose()

      let exploding = false
      let explodeT = 0
      const explodeDur = 0.95
      let cooldown = 0
      const hitCooldownMs = 520

      const velDot = new Float32Array(dotIdx.length * 3)
      const velSprite: THREE.Vector3[] = spriteList.map(() => new THREE.Vector3())

      function removeUserSpriteAt(index: number) {
        const rec = spriteList[index]
        rec.spr.material.map?.dispose()
        rec.spr.material.dispose()
        root.remove(rec.spr)
        spriteList.splice(index, 1)
        velSprite.splice(index, 1)
      }

      function trimOldUserSprites(howManyNew: number) {
        while (
          spriteList.length - baseSpriteCount + howManyNew >
          MAX_USER_SPRITES
        ) {
          if (spriteList.length <= baseSpriteCount) break
          removeUserSpriteAt(baseSpriteCount)
        }
      }

      function resetSphere() {
        exploding = false
        explodeT = 0
        for (let j = 0; j < dotIdx.length; j++) {
          dotPos[j * 3] = baseDot[j * 3]
          dotPos[j * 3 + 1] = baseDot[j * 3 + 1]
          dotPos[j * 3 + 2] = baseDot[j * 3 + 2]
        }
        dotGeo.attributes.position.needsUpdate = true
        for (let i = 0; i < spriteList.length; i++) {
          spriteList[i].spr.position.copy(spriteList[i].base)
          const rec = spriteList[i]
          const baseOp = rec.kind === 'user' ? 1 : 0.94
          ;(rec.spr.material as THREE.SpriteMaterial).opacity = baseOp
          rec.spr.scale.set(rec.baseScaleX, rec.baseScaleY, 1)
        }
        dotsMat.opacity = 0.92
      }

      function beginExplode() {
        exploding = true
        explodeT = 0
        triggerHitFlash()
        playPunchSfx()
        onHitRef.current?.()

        for (let j = 0; j < dotIdx.length; j++) {
          const bx = baseDot[j * 3]
          const by = baseDot[j * 3 + 1]
          const bz = baseDot[j * 3 + 2]
          const len = Math.hypot(bx, by, bz) || 1
          const jitter = 0.35 + Math.random() * 1.25
          velDot[j * 3] = (bx / len) * (2.1 + Math.random() * 2.4) * jitter
          velDot[j * 3 + 1] = (by / len) * (2.1 + Math.random() * 2.4) * jitter
          velDot[j * 3 + 2] = (bz / len) * (2.1 + Math.random() * 2.4) * jitter
        }
        for (let i = 0; i < spriteList.length; i++) {
          const b = spriteList[i].base
          const len = b.length() || 1
          const jitter = 0.4 + Math.random() * 1.1
          velSprite[i].set(
            (b.x / len) * (2.4 + Math.random() * 2.8) * jitter,
            (b.y / len) * (2.4 + Math.random() * 2.8) * jitter,
            (b.z / len) * (2.4 + Math.random() * 2.8) * jitter,
          )
        }
      }

      apiRef.current.appendUserTextParticles = (fragment: string) => {
        if (exploding || !fragment.trim()) return
        const tokens = tokenizeForParticles(fragment).slice(
          0,
          MAX_USER_TOKENS_PER_APPEND,
        )
        if (tokens.length === 0) return
        trimOldUserSprites(tokens.length)
        for (const tok of tokens) {
          const tex = makeUserParticleTexture(tok)
          const mat = new THREE.SpriteMaterial({
            map: tex,
            transparent: true,
            opacity: 1,
            depthWrite: false,
            depthTest: false,
            blending: THREE.NormalBlending,
          })
          const spr = new THREE.Sprite(mat)
          spr.renderOrder = 999
          const isCjkSingle =
            tok.length === 1 && CJK_RANGE_RE.test(tok)
          const { baseW, baseH } = scaleForUserSprite(tex, isCjkSingle)
          spr.scale.set(baseW, baseH, 1)
          const p = randomPointOnSphere(SPHERE_R * 1.06)
          spr.position.copy(p)
          root.add(spr)
          spriteList.push({
            spr,
            base: p.clone(),
            kind: 'user',
            baseScaleX: baseW,
            baseScaleY: baseH,
          })
          velSprite.push(new THREE.Vector3())
        }
      }

      apiRef.current.tryPunch = (ndc) => {
        if (!visibleRef.current) return false
        if (exploding) return false
        if (performance.now() < cooldown) return false
        raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera)
        const hits = raycaster.intersectObject(collider, false)
        if (hits.length === 0) return false
        beginExplode()
        cooldown = performance.now() + hitCooldownMs
        return true
      }

      let raf = 0
      let last = performance.now()

      const tick = (now: number) => {
        const dt = Math.min(0.05, (now - last) / 1000)
        last = now

        if (!exploding) {
          root.rotation.y += dt * 0.52
          root.rotation.x = Math.sin(now * 0.00031) * 0.09
        } else {
          explodeT += dt
          const fade = Math.max(0, 1 - explodeT / explodeDur)

          for (let j = 0; j < dotIdx.length; j++) {
            dotPos[j * 3] += velDot[j * 3] * dt
            dotPos[j * 3 + 1] += velDot[j * 3 + 1] * dt
            dotPos[j * 3 + 2] += velDot[j * 3 + 2] * dt
            velDot[j * 3] *= 0.985
            velDot[j * 3 + 1] *= 0.985
            velDot[j * 3 + 2] *= 0.985
          }
          dotGeo.attributes.position.needsUpdate = true
          dotsMat.opacity = 0.92 * fade

          for (let i = 0; i < spriteList.length; i++) {
            const sp = spriteList[i].spr
            sp.position.addScaledVector(velSprite[i], dt)
            velSprite[i].multiplyScalar(0.982)
            const baseOp = spriteList[i].kind === 'user' ? 1 : 0.94
            ;(sp.material as THREE.SpriteMaterial).opacity = baseOp * fade
            sp.scale.multiplyScalar(0.99)
          }

          if (explodeT >= explodeDur) {
            resetSphere()
            cooldown = performance.now() + 280
          }
        }

        renderer.render(scene, camera)
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)

      const resize = () => {
        const w = mount.clientWidth || 1
        const h = mount.clientHeight || 1
        camera.aspect = w / h
        camera.updateProjectionMatrix()
        renderer.setSize(w, h, false)
      }
      const ro = new ResizeObserver(resize)
      ro.observe(mount)
      resize()

      return () => {
        cancelAnimationFrame(raf)
        ro.disconnect()
        flashLayer.remove()
        apiRef.current.tryPunch = () => false
        apiRef.current.appendUserTextParticles = () => {}
        dotTexture.dispose()
        charTex.hash.dispose()
        charTex.at.dispose()
        charTex.amp.dispose()
        charTex.pct.dispose()
        root.remove(dotPoints)
        dotGeo.dispose()
        dotsMat.dispose()
        for (const s of spriteList) {
          s.spr.material.map?.dispose()
          s.spr.material.dispose()
          root.remove(s.spr)
        }
        collider.geometry.dispose()
        ;(collider.material as THREE.Material).dispose()
        renderer.dispose()
        mount.removeChild(renderer.domElement)
      }
    }, [])

    return (
      <div
        ref={mountRef}
        className="particle-punch-overlay"
        aria-hidden={!visible}
        style={{
          opacity: visible ? 1 : 0,
          pointerEvents: 'none',
        }}
      />
    )
  },
)
