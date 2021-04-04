const { Physics, PlayerState } = require('prismarine-physics')
const { performance } = require('perf_hooks')
const { d2r } = require('./util')
const vec3 = require('vec3')

const PHYSICS_INTERVAL_MS = 50
const PHYSICS_TIMESTEP = PHYSICS_INTERVAL_MS / 1000

class MovementManager {
  // Server auth movement : we send inputs, server calculates position & sends back
  serverMovements = false

  constructor (bot) {
    this.bot = bot
    this.world = bot.world
    // Physics tick
    this.tick = 0n
  }

  get lastPos () { return this.player.entity.position.clone() }
  set lastPos (newPos) { this.player.entity.position.set(newPos.x, newPos.y, newPos.z) }

  get lastRot () { return vec3(this.player.entity.yaw, this.player.entity.pitch, this.player.entity.headYaw) }

  set lastRot (rot) {
    this.player.entity.yaw = rot.x
    this.player.entity.pitch = rot.y
    if (rot.z) this.player.entity.headYaw = rot.z
  }

  // Ask the server to be in a new position
  requestPosition (time, inputState) {
    const positionUpdated = !this.lastSentPos || !this.lastPos.equals(this.lastSentPos)
    const rotationUpdated = !this.lastSentRot || !this.lastRot.equals(this.lastSentRot)

    if (positionUpdated) {
      this.lastSentPos = this.lastPos.clone()
      console.log('We computed', this.lastPos)
      this.bot.updatePlayerCamera(2, this.lastSentPos, this.playerState.yaw, this.playerState.pitch)
      if (this.serverMovements) {
        this.client.queue('player_auth_input', {
          pitch: this.player.pitch,
          yaw: this.player.yaw,
          position: {
            x: this.lastPos.x,
            y: this.lastPos.y,
            z: this.lastPos.z
          },
          move_vector: { // Minecraft coords, N: Z+1, S: Z-1, W: X+1, E: X-1
            x: inputState.left ? 1 : (inputState.right ? -1 : 0),
            z: inputState.up ? 1 : (inputState.down ? -1 : 0)
          },
          head_yaw: this.player.headYaw,
          input_data: inputState,
          input_mode: 'mouse',
          play_mode: 'screen',
          tick: this.tick,
          delta: this.lastSentPos?.minus(this.lastPos) ?? { x: 0, y: 0, z: 0 }
        })
        this.positionUpdated = false
      }

      this.lastSentPos = this.lastPos
      this.lastSentRot = this.lastRot
    }
  }

  init (movementAuthority, position, velocity, yaw = 0, pitch = 0, headYaw = 0) {
    if (movementAuthority.includes('server')) {
      this.serverMovements = true
    }
    this.player = {
      version: '1.16.1',
      inventory: {
        slots: []
      },
      entity: {
        effects: {},
        position: vec3(position),
        velocity: vec3(velocity),
        onGround: false,
        isInWater: false,
        isInLava: false,
        isInWeb: false,
        isCollidedHorizontally: false,
        isCollidedVertically: false,
        yaw,
        pitch,
        headYaw // bedrock
      },
      events: { // Control events to send next tick
        startSprint: false,
        stopSprint: false,
        startSneak: false,
        stopSneak: false
      },
      jumpTicks: 0,
      jumpQueued: false,
      downJump: false
    }

    const mcData = require('minecraft-data')('1.16.1')
    this.physics = Physics(mcData, this.world)
    this.controls = {
      forward: false,
      back: false,
      left: false,
      right: false,
      jump: false,
      sprint: false,
      sneak: false
    }
  }

  // This function should be executed each tick (every 0.05 seconds)
  // How it works: https://gafferongames.com/post/fix_your_timestep/
  timeAccumulator = 0
  lastPhysicsFrameTime = null
  inputQueue = []
  doPhysics () {
    const now = performance.now()
    const deltaSeconds = (now - this.lastPhysicsFrameTime) / 1000
    this.lastPhysicsFrameTime = now

    this.timeAccumulator += deltaSeconds

    while (this.timeAccumulator >= PHYSICS_TIMESTEP) {
      const q = this.inputQueue.shift()
      if (q) {
        Object.assign(this.playerState.control, q)
        if (q.yaw) this.player.entity.yaw = q.yaw
        if (q.pitch) this.player.entity.pitch = q.pitch
      }
      this.playerState = new PlayerState(this.player, this.controls)
      this.physics.simulatePlayer(this.playerState, this.world.sync).apply(this.player)
      this.lastPos = this.playerState.pos
      this.requestPosition(PHYSICS_TIMESTEP, {
        ascend: false,
        descend: false,
        // Players bob up and down in water, north jump is true when going up.
        // In water this is only true after the player has reached max height before bobbing back down.
        north_jump: this.player.jumpTicks > 0, // Jump
        jump_down: this.controls.jump, // Jump
        sprint_down: this.controls.sprint,
        change_height: false,
        jumping: this.controls.jump, // Jump
        auto_jumping_in_water: false,
        sneaking: false,
        sneak_down: false,
        up: this.controls.forward,
        down: this.controls.back,
        left: this.controls.left,
        right: this.controls.right,
        up_left: false,
        up_right: false,
        want_up: this.controls.jump, // Jump
        want_down: false,
        want_down_slow: false,
        want_up_slow: false,
        sprinting: false,
        ascend_scaffolding: false,
        descend_scaffolding: false,
        sneak_toggle_down: false,
        persist_sneak: false,
        start_sprinting: this.player.events.startSprint || false,
        stop_sprinting: this.player.events.stopSprint || false,
        start_sneaking: this.player.events.startSneak || false,
        stop_sneaking: this.player.events.stopSneak || false,
        // Player is Update Aqatic swimming
        start_swimming: false,
        // Player stops Update Aqatic swimming
        stop_swimming: false,
        start_jumping: this.player.jumpTicks === 1, // Jump
        start_gliding: false,
        stop_gliding: false
      })
      this.timeAccumulator -= PHYSICS_TIMESTEP
    }
  }

  startPhys () {
    console.log('Start phys')
    this.physicsLoop = setInterval(() => {
      this.doPhysics()
    }, PHYSICS_INTERVAL_MS)
  }

  setControlState (control, state) {
    if (this.controls[control] === state) return
    if (control === 'sprint') {
      this.player.events.startSprint = state
      this.player.events.stopSprint = !state
      this.controls.sprint = true
    } else if (control === 'sneak') {
      this.player.events.startSneak = state
      this.player.events.stopSneak = !state
      this.controls.sprint = true
    }
  }

  stopPhys () {
    clearInterval(this.physicsLoop)
  }

  pushInputState (state, yaw, pitch) {
    const yawRad = d2r(yaw)
    const pitchRad = d2r(pitch)
    this.inputQueue.push({
      forward: state.up,
      back: state.down, // TODO: left and right switched ???
      left: state.right,
      right: state.left,
      jump: state.jump_down,
      sneak: state.sneak_down,
      yaw: yawRad,
      pitch: pitchRad
    })
    // debug
    globalThis.debugYaw = [yaw, yawRad]
  }

  pushCameraControl (state, id = 1) {
    let { x, y, z } = state.position
    if (id === 1) y -= 1.62 // account for player bb
    const adjPos = vec3({ x, y, z })
    // Sneak resyncs the position for easy testing
    this.bot.updatePlayerCamera(id, adjPos, d2r(state.yaw), d2r(state.pitch), state.input_data.sneak_down)
  }

  // Server gives us a new position
  updatePosition (pos, yaw, pitch, headYaw, tick) {
    this.lastPos = pos
    this.lastRot = { x: yaw, y: pitch, z: headYaw }
    if (tick) this.tick = tick
  }

  onViewerCameraMove (newYaw, newPitch, newHeadYaw) {
    this.player.yaw = newYaw
    this.player.pitch = newPitch
    this.player.headYaw = newHeadYaw
  }
}

module.exports = { MovementManager }