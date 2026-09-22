function roundedPosition(position) {
  if (!position) return null
  return {
    x: Math.round(position.x * 10) / 10,
    y: Math.round(position.y * 10) / 10,
    z: Math.round(position.z * 10) / 10
  }
}

class EpisodeExplorationState {
  constructor({ regionSize = 4, maxRadius = 16, maxRegions = 12, maxDestinations = 8, maxBlockSnapshots = 6 } = {}) {
    this.regionSize = regionSize
    this.maxRadius = maxRadius
    this.maxRegions = maxRegions
    this.maxDestinations = maxDestinations
    this.maxBlockSnapshots = maxBlockSnapshots
    this.step = 0
    this.regions = new Map()
    this.destinations = []
    this.blockSnapshots = []
    this.origin = null
  }

  observe(observation) {
    const position = observation?.position
    if (!position) return false
    if (!this.origin) this.origin = roundedPosition(position)
    this.step += 1
    const region = this.regionKey(position)
    const previous = this.regions.get(region) || { region, visits: 0, lastObservedStep: 0, position: null }
    this.regions.set(region, {
      region,
      visits: previous.visits + 1,
      lastObservedStep: this.step,
      position: roundedPosition(position)
    })

    const blocks = (observation.nearbyBlocks || []).slice(0, 16)
    this.blockSnapshots.push({
      step: this.step,
      region,
      names: [...new Set(blocks.map(block => block.name).filter(Boolean))].slice(0, 12),
      refs: blocks.map(block => block.ref).filter(Boolean).slice(0, 12)
    })
    if (this.blockSnapshots.length > this.maxBlockSnapshots) this.blockSnapshots.shift()
    return true
  }

  recordExploration(action, result) {
    this.destinations.push({
      heading: action.heading,
      distance: action.distance,
      destination: roundedPosition(result?.destination),
      success: Boolean(result?.success),
      reason: result?.reason || null,
      completedAtStep: this.step
    })
    if (this.destinations.length > this.maxDestinations) this.destinations.shift()
  }

  regionKey(position) {
    if (!position) return null
    return [position.x, position.y, position.z]
      .map(value => Math.floor(value / this.regionSize))
      .join(',')
  }

  novelty(position) {
    const region = this.regions.get(this.regionKey(position))
    return {
      visits: region?.visits || 0,
      lastObservedStep: region?.lastObservedStep || 0
    }
  }

  isWithinBounds(position) {
    if (!this.origin || !position) return true
    return Math.hypot(position.x - this.origin.x, position.z - this.origin.z) <= this.maxRadius
  }

  snapshot() {
    const recentObservedRegions = [...this.regions.values()]
      .sort((a, b) => b.lastObservedStep - a.lastObservedStep)
      .slice(0, this.maxRegions)
    return {
      regionSize: this.regionSize,
      origin: this.origin,
      maxRadius: this.maxRadius,
      recentObservedRegions,
      recentExploredDestinations: [...this.destinations].reverse(),
      recentBlockObservations: [...this.blockSnapshots].reverse()
    }
  }
}

module.exports = { EpisodeExplorationState, roundedPosition }
