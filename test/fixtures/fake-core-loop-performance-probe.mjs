// Schema/CLI fixture only. These constant samples are not performance evidence.

function sample({ topology, repetition, phase, processType, processSlot, elapsedMs = 0 }) {
  return {
    topology,
    repetition,
    phase,
    elapsedMs,
    processType,
    processSlot,
    cpuPercent: processType === 'main' ? 2 : 1,
    memoryMiB: processType === 'main' ? 100 : 50,
    frameIntervalMs: processType === 'renderer' ? 16.7 : null,
    renderWorkMs: processType === 'renderer' ? 1.2 : null,
    longFrame: false,
    eventLoopStallMs: 0,
    crashCount: 0,
    unhandledErrorCount: 0,
    petCount: phase === 'recovery' ? 0 : topology,
    windowCount: phase === 'recovery' ? 0 : topology,
    timerCount: phase === 'recovery' ? 0 : topology,
    listenerCount: phase === 'recovery' ? 0 : topology,
  };
}

export async function collectPerformanceScenario({ config, emit }) {
  for (const phase of ['idle', 'active']) {
    emit(sample({ ...config, phase, processType: 'main', processSlot: 0 }));
    for (let slot = 1; slot <= config.topology; slot++) {
      emit(sample({ ...config, phase, processType: 'renderer', processSlot: slot }));
    }
  }
  emit(sample({ ...config, phase: 'recovery', processType: 'main', processSlot: 0 }));
}

export async function collectPerformanceSoak({ config, emit }) {
  emit(sample({ ...config, phase: 'soak', processType: 'main', processSlot: 0, elapsedMs: 0 }));
  emit(sample({ ...config, phase: 'soak', processType: 'main', processSlot: 0, elapsedMs: 1 }));
  for (let slot = 1; slot <= config.topology; slot++) {
    emit(sample({ ...config, phase: 'soak', processType: 'renderer', processSlot: slot }));
  }
}
