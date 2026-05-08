import Matter from 'matter-js'

const MAX_CHARS = 100

/**
 * 在固定像素画布上把每个字符变成受重力矩形，直到调用返回的 teardown。
 */
export function startTextMatterWorld(
  canvas: HTMLCanvasElement,
  rawText: string,
): () => void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return () => {}

  const glyphs = Array.from(rawText.replace(/\r/g, '')).slice(0, MAX_CHARS)
  if (glyphs.length === 0) glyphs.push('·')

  const w = canvas.width
  const h = canvas.height
  const engine = Matter.Engine.create({ enableSleeping: true })
  engine.world.gravity.y = 1.1
  engine.world.gravity.scale = 0.001

  const t = 48
  const ground = Matter.Bodies.rectangle(w / 2, h + t / 2 - 2, w + 120, t, {
    isStatic: true,
  })
  const left = Matter.Bodies.rectangle(-t / 2, h / 2, t, h + t * 4, {
    isStatic: true,
  })
  const right = Matter.Bodies.rectangle(w + t / 2, h / 2, t, h + t * 4, {
    isStatic: true,
  })
  const ceiling = Matter.Bodies.rectangle(w / 2, -t * 3, w + 120, t, {
    isStatic: true,
  })
  Matter.Composite.add(engine.world, [ground, left, right, ceiling])

  const cols = Math.max(8, Math.floor((w - 56) / 30))
  const bodies: Matter.Body[] = []
  glyphs.forEach((ch, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const bw = ch === ' ' ? 12 : ch === '\n' ? 12 : 26
    const bh = 30
    const x = 28 + col * 30 + (Math.random() - 0.5) * 10
    const y = -45 - row * 34 - Math.random() * 24
    if (ch === '\n') return
    const b = Matter.Bodies.rectangle(x, y, bw, bh, {
      restitution: 0.28,
      friction: 0.12,
      frictionAir: 0.012,
      chamfer: { radius: 5 },
      label: ch,
    })
    bodies.push(b)
  })
  Matter.Composite.add(engine.world, bodies)

  let raf = 0
  const tick = () => {
    Matter.Engine.update(engine, 1000 / 60)
    ctx.clearRect(0, 0, w, h)
    ctx.strokeStyle = 'rgba(30, 96, 207, 0.7)'
    ctx.lineWidth = 1.25
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
      ctx.fillStyle = 'rgba(8, 10, 18, 0.9)'
      ctx.strokeStyle = 'rgba(80, 160, 255, 0.88)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.rect(-bw / 2, -bh / 2, bw, bh)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = '#eef0f6'
      ctx.font = '600 13px "IBM Plex Mono", ui-monospace, monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(ch, 0, 1)
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
