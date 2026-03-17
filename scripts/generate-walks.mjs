import { PixelLabClient, Base64Image } from '@pixellab-code/pixellab'
import { config } from 'dotenv'
import { existsSync } from 'fs'
import { join } from 'path'

config({ path: '.env' })

const client = new PixelLabClient(process.env.PIXELLAB_SECRET)
const SPRITES_DIR = join(process.cwd(), 'public', 'sprites')

const CHARACTERS = [
  { id: 'debugger',  desc: 'office worker with red shirt' },
  { id: 'reviewer',  desc: 'office worker with blue shirt' },
  { id: 'frontend',  desc: 'office worker with green shirt' },
  { id: 'fullstack', desc: 'office worker with purple shirt' },
  { id: 'tester',    desc: 'office worker with orange shirt' },
  { id: 'security',  desc: 'office worker with dark orange shirt' },
  { id: 'devops',    desc: 'office worker with grey shirt' },
  { id: 'manager',   desc: 'office manager with dark navy suit' },
]

async function generateWalk(char) {
  const checkPath = join(SPRITES_DIR, `${char.id}-walk-0.png`)
  if (existsSync(checkPath)) {
    console.log(`⏭️  ${char.id} walk already exists`)
    return
  }

  const refPath = join(SPRITES_DIR, `${char.id}.png`)
  if (!existsSync(refPath)) {
    console.log(`❌ No base sprite for ${char.id}`)
    return
  }

  console.log(`🚶 Generating walk for ${char.id}...`)
  const refImage = await Base64Image.fromFile(refPath)

  try {
    // Step 1: Estimate skeleton from the character
    console.log(`   Estimating skeleton...`)
    const skeleton = await client.estimateSkeleton({
      imageSize: { width: 32, height: 32 },
      image: refImage,
    })

    console.log(`   Got skeleton, keys: ${Object.keys(skeleton)}`)

    // Step 2: Use skeleton for animation
    const response = await client.animateWithSkeleton({
      imageSize: { width: 32, height: 32 },
      referenceImage: refImage,
      skeletonKeypoints: skeleton.keypoints || skeleton.skeletonKeypoints || skeleton,
      view: 'high top-down',
      direction: 'south',
      nFrames: 4,
    })

    if (response.images && response.images.length > 0) {
      for (let i = 0; i < response.images.length; i++) {
        const framePath = join(SPRITES_DIR, `${char.id}-walk-${i}.png`)
        await response.images[i].saveToFile(framePath)
      }
      console.log(`✅ ${char.id}: ${response.images.length} walk frames`)
    }
  } catch (err) {
    console.error(`❌ ${char.id} failed: ${err.message?.slice(0, 150)}`)

    // Ultimate fallback: generate 4 slightly varied static sprites
    // using pixflux with walk descriptions
    console.log(`   Generating walk variants with pixflux...`)
    const walkDescs = [
      `${char.desc} walking left foot forward`,
      `${char.desc} standing`,
      `${char.desc} walking right foot forward`,
      `${char.desc} standing still`,
    ]

    for (let i = 0; i < 4; i++) {
      try {
        const res = await client.generateImagePixflux({
          description: `tiny pixel art top-down view ${walkDescs[i]}, 16-bit game character, facing down, simple pixel art, office worker`,
          imageSize: { width: 32, height: 32 },
          negativeDescription: 'blurry, realistic, 3d, side view, complex, large',
          textGuidanceScale: 8.0,
          noBackground: true,
          outline: 'single color black outline',
          shading: 'basic shading',
          detail: 'low detail',
          initImage: refImage,
          initImageStrength: 70,
        })
        const framePath = join(SPRITES_DIR, `${char.id}-walk-${i}.png`)
        await res.image.saveToFile(framePath)
        console.log(`   ✅ Frame ${i} saved`)
      } catch (e2) {
        console.error(`   ❌ Frame ${i} failed: ${e2.message?.slice(0, 80)}`)
      }
    }
  }
}

async function main() {
  console.log('🚶 Walk Animation Generator\n')
  for (const char of CHARACTERS) {
    await generateWalk(char)
  }
  console.log('\n🏁 Done!')
}

main().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
