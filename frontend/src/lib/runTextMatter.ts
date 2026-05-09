import Matter from 'matter-js'

const MAX_CHARS = 100
/** 食指影响半径（画布像素） */
const PROBE_RADIUS = 110
/** 推力强度（Matter 单位，需与 gravity scale 匹配） */
const PROBE_FORCE = 0.00085

export type HandProbePoint = { x: number; y: number } | null

/**
 * 在固定像素画布上把每个字符变成刚体；下落位置/角速度随机；
 * 每帧从 getHandProbe 读取食指尖（与画布同坐标系），扫过附近字块时推开。
 */
export function startTextMatterWorld(
  canvas: HTMLCanvasElement,
  rawText: string,
  getHandProbe: () => HandProbePoint,
): () => void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return () => {}

  const glyphs = Array.from(rawText.replace(/\r/g, '')).slice(0, MAX_CHARS)
  if (glyphs.length === 0) glyphs.push('·')

  const w = canvas.width
  const h = canvas.height
  const engine = Matter.Engine.create({ enableSleeping: true })
  engine.world.gravity.y = 1.08
  engine.world.gravity.scale = 0.001

  const t = 52
  const ground = Matter.Bodies.rectangle(w / 2, h + t / 2 - 2, w + 160, t, {
    isStatic: true,
  })
  const left = Matter.Bodies.rectangle(-t / 2, h / 2, t, h + t * 4, {
    isStatic: true,
  })
  const right = Matter.Bodies.rectangle(w + t / 2, h / 2, t, h + t * 4, {
    isStatic: true,
  })
  /** 不要使用贴近生成区顶部的 ceiling：字形从画面上方落下时易与其挤碰后被 enableSleeping 误判休眠，只剩少量继续下落。 */
  Matter.Composite.add(engine.world, [ground, left, right])

  const bodies: Matter.Body[] = []
  let spawnIndex = 0
  for (const ch of glyphs) {
    if (ch === '\n') continue
    const bw = ch === ' ' ? 28 : 58
    const bh = 62
    const margin = bw / 2 + 28
    const x =
      margin + Math.random() * Math.max(40, w - margin * 2)
    const y =
      -55 -
      spawnIndex * (14 + Math.random() * 32) -
      Math.random() * 140 -
      Math.pow(Math.random(), 1.4) * 90
    spawnIndex += 1

    const angle = (Math.random() - 0.5) * 1.15
    const b = Matter.Bodies.rectangle(x, y, bw, bh, {
      angle,
      restitution: 0.32,
      friction: 0.1,
      frictionAir: 0.008,
      chamfer: { radius: 7 },
      label: ch,
    })
    Matter.Body.setVelocity(b, {
      x: (Math.random() - 0.5) * 3.2,
      y: (Math.random() - 0.5) * 2.4,
    })
    Matter.Body.setAngularVelocity(b, (Math.random() - 0.5) * 0.12)
    bodies.push(b)
  }
  Matter.Composite.add(engine.world, bodies)

  let raf = 0
  const tick = () => {
    const probe = getHandProbe()
    if (probe) {
      for (const body of bodies) {
        const dx = body.position.x - probe.x
        const dy = body.position.y - probe.y
        const d2 = dx * dx + dy * dy
        const r = PROBE_RADIUS
        if (d2 < r * r && d2 > 2) {
          const d = Math.sqrt(d2)
          const falloff = (1 - d / r) ** 1.6
          const f = PROBE_FORCE * falloff
          Matter.Body.applyForce(body, body.position, {
            x: (dx / d) * f,
            y: (dy / d) * f,
          })
          const spin = 0.035 * falloff * (Math.random() > 0.5 ? 1 : -1)
          Matter.Body.setAngularVelocity(
            body,
            body.angularVelocity + spin,
          )
        }
      }
    }

    Matter.Engine.update(engine, 1000 / 60)

    ctx.clearRect(0, 0, w, h)

    if (probe) {
      ctx.save()
      ctx.strokeStyle = 'rgba(248, 248, 250, 0.28)'
      ctx.lineWidth = 1
      ctx.setLineDash([5, 7])
      ctx.beginPath()
      ctx.arc(probe.x, probe.y, PROBE_RADIUS * 0.92, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(248, 248, 250, 0.12)'
      ctx.beginPath()
      ctx.arc(probe.x, probe.y, 7, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }

    ctx.strokeStyle = 'rgba(248, 248, 250, 0.35)'
    ctx.lineWidth = 1
    ctx.strokeRect(1, 1, w - 2, h - 2)

    const all = Matter.Composite.allBodies(engine.world)
    for (const body of all) {
      if (body.isStatic) continue
      const ch = body.label
      ctx.save()
      ctx.translate(body.position.x, body.position.y)
      ctx.rotate(body.angle)
      const { min, max } = body.bounds
      const bw = max.x - min.x
      const bh = max.y - min.y
      ctx.fillStyle = 'rgba(6, 6, 10, 0.94)'
      ctx.strokeStyle = 'rgba(248, 248, 250, 0.52)'
      ctx.lineWidth = 1.35
      ctx.beginPath()
      ctx.rect(-bw / 2, -bh / 2, bw, bh)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = '#f6f6f8'
      ctx.font = '600 30px "IBM Plex Mono", ui-monospace, monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(ch, 0, 0)
      ctx.restore()
    }

    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  return () => {
    cancelAnimationFrame(raf)
    Matter.World.clear(engine.world, false)
    Matter.Engine.clear(engine)
  }
}
