import Replicate from 'replicate'
import { config } from 'dotenv'
import { writeFileSync } from 'fs'
import { join } from 'path'

config({ path: '.env' })

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN })

async function generate(prompt, filename) {
  console.log(`🏢 Generating ${filename}...`)

  const output = await replicate.run(
    'google/nano-banana-pro',
    {
      input: {
        prompt,
        aspect_ratio: '1:1',
        output_format: 'png',
        safety_filter_level: 'block_only_high',
        number_of_images: 1,
      },
    }
  )

  const imageData = Array.isArray(output) ? output[0] : output
  const chunks = []
  for await (const chunk of imageData) {
    chunks.push(chunk)
  }
  const buffer = Buffer.concat(chunks)
  const outPath = join(process.cwd(), 'public', filename)
  writeFileSync(outPath, buffer)
  console.log(`✅ Saved ${filename} (${(buffer.length / 1024).toFixed(1)}KB)`)
}

async function main() {
  // Generate a few variations so we can pick the best
  await generate(
    'top-down view pixel art office interior, 16-bit retro game style, dark moody lighting, small cramped office room with 6 wooden desks arranged in 2 rows of 3 each with computer monitors and office chairs, water cooler in corner, coffee machine, potted plants, filing cabinets, elevator door on right wall, overhead fluorescent lights casting warm pools of light, GTA 1 GTA 2 style overhead view, game asset, dark carpet floor tiles, no people, no characters, clean pixel art, indie game',
    'office-bg-6desk.png'
  )

  await generate(
    'pixel art top-down view of a small dark office room, retro 16-bit game style, 6 computer workstation desks in 2 rows of 3, each desk has monitor keyboard and chair, carpet floor with grid pattern, warm overhead lighting pools, water cooler, coffee machine area, plant pots, metal elevator doors on right side, filing cabinets along walls, GTA 1 style birds eye view, game tileset, moody atmosphere, no characters present',
    'office-bg-6desk-v2.png'
  )
}

main().catch(err => {
  console.error('❌ Error:', err.message)
  process.exit(1)
})
