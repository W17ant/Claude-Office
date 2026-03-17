import { PixelLabClient, Base64Image } from '@pixellab-code/pixellab'
import { config } from 'dotenv'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

config({ path: '.env' })

const client = new PixelLabClient(process.env.PIXELLAB_SECRET)
const SPRITES_DIR = join(process.cwd(), 'public', 'sprites')

// Characters to generate - each agent type with their shirt color
const CHARACTERS = [
  { id: 'debugger',     color: 'red',         desc: 'office worker with red shirt' },
  { id: 'reviewer',     color: 'blue',        desc: 'office worker with blue shirt' },
  { id: 'frontend',     color: 'green',       desc: 'office worker with green shirt' },
  { id: 'fullstack',    color: 'purple',      desc: 'office worker with purple shirt' },
  { id: 'tester',       color: 'orange',      desc: 'office worker with orange shirt' },
  { id: 'security',     color: 'dark orange',  desc: 'office worker with dark orange shirt' },
  { id: 'devops',       color: 'grey',        desc: 'office worker with grey shirt' },
  { id: 'manager',      color: 'dark navy',   desc: 'office manager with dark navy suit and tie' },
]

async function checkBalance() {
  const bal = await client.getBalance()
  console.log(`💰 Balance: ${bal.balance} ${bal.currency}`)
  return bal.balance
}

async function generateCharacter(char) {
  const outPath = join(SPRITES_DIR, `${char.id}.png`)
  if (existsSync(outPath)) {
    console.log(`⏭️  ${char.id} already exists, skipping`)
    return outPath
  }

  console.log(`🎨 Generating ${char.id}...`)

  const response = await client.generateImagePixflux({
    description: `tiny pixel art top-down view ${char.desc}, 16-bit style game character, facing down, simple clean pixel art style, office worker`,
    imageSize: { width: 32, height: 32 },
    negativeDescription: 'blurry, realistic, 3d, side view, complex, detailed face, large',
    textGuidanceScale: 8.0,
    noBackground: true,
    outline: 'single color black outline',
    shading: 'basic shading',
    detail: 'low detail',
  })

  await response.image.saveToFile(outPath)
  console.log(`✅ Saved ${char.id}.png`)
  return outPath
}

async function generateWalkAnimation(char) {
  const outPath = join(SPRITES_DIR, `${char.id}-walk.png`)
  if (existsSync(outPath)) {
    console.log(`⏭️  ${char.id}-walk already exists, skipping`)
    return
  }

  const refPath = join(SPRITES_DIR, `${char.id}.png`)
  if (!existsSync(refPath)) {
    console.log(`❌ No base sprite for ${char.id}, skipping walk animation`)
    return
  }

  console.log(`🚶 Generating walk animation for ${char.id}...`)

  const refImage = await Base64Image.fromFile(refPath)

  const response = await client.animateWithText({
    imageSize: { width: 64, height: 64 },
    description: `tiny pixel art top-down ${char.desc}, 16-bit game character`,
    action: 'walk',
    referenceImage: refImage,
    direction: 'down',
    nFrames: 4,
  })

  // Save each frame
  if (response.images && response.images.length > 0) {
    for (let i = 0; i < response.images.length; i++) {
      const framePath = join(SPRITES_DIR, `${char.id}-walk-${i}.png`)
      await response.images[i].saveToFile(framePath)
    }
    console.log(`✅ Saved ${char.id} walk frames (${response.images.length} frames)`)
  } else if (response.image) {
    await response.image.saveToFile(outPath)
    console.log(`✅ Saved ${char.id}-walk.png`)
  }
}

async function main() {
  console.log('🏢 Agent Office Sprite Generator')
  console.log('=================================\n')

  const balance = await checkBalance()

  // Phase 1: Generate base character sprites (8 credits)
  console.log('\n📌 Phase 1: Base characters\n')
  for (const char of CHARACTERS) {
    await generateCharacter(char)
  }

  // Check remaining balance
  const afterBase = await checkBalance()

  // Phase 2: Generate walk animations for key characters
  // Only if we have enough credits (each animation ~1 credit)
  if (afterBase >= CHARACTERS.length) {
    console.log('\n📌 Phase 2: Walk animations\n')
    for (const char of CHARACTERS) {
      await generateWalkAnimation(char)
    }
  } else {
    console.log(`\n⚠️  ${afterBase} credits remaining - skipping walk animations`)
    console.log('Run this script again later to generate them')
  }

  const finalBalance = await checkBalance()
  console.log(`\n🏁 Done! ${finalBalance} credits remaining`)
}

main().catch(err => {
  console.error('❌ Error:', err.message)
  process.exit(1)
})
