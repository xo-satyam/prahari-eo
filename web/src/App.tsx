import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleStop,
  ClipboardCopy,
  Database,
  Home,
  Keyboard,
  LoaderCircle,
  Radar,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  SquareActivity,
  TerminalSquare,
  Wifi,
  X,
} from 'lucide-react'
import { CameraViewport } from './components/CameraViewport'
import { fetchHealth, getStoredToken, storeToken, telemetrySocketUrl, withTokenQuery } from './services/api'
import { usePrahariApi } from './hooks/usePrahariApi'
import type { Health, LogRow, Mode, Telemetry, Tuning } from './types/prahari'
import { clone, emptyTune, fmt, isTypingTarget } from './utils'

type LinkState =
  | 'CONNECTING'
  | 'ONLINE'
  | 'DISCONNECTED'
  | 'LINK ERROR'
  | 'SERVICE OFFLINE'
  | 'TOKEN REQUIRED'
  | 'AUTH REQUIRED'
  | 'E-STOP LATCHED'
  | 'FAULT'

function reportsSimulatedInput(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const payload = value as { simulation?: unknown; camera?: { simulation?: unknown } }
  return payload.simulation === true || payload.camera?.simulation === true
}

type Toast = { tone: 'ok' | 'warn' | 'err'; message: string }

const MODE_LABEL: Record<Mode, string> = { idle: 'IDLE', manual: 'MANUAL', auto: 'AUTO' }

export default function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null)
  const [simulatedInputBlocked, setSimulatedInputBlocked] = useState(false)
  const [token, setToken] = useState(() => getStoredToken())
  const [tokenDraft, setTokenDraft] = useState('')
  const [authOpen, setAuthOpen] = useState(false)
  const [authError, setAuthError] = useState('')
  const [link, setLink] = useState<LinkState>('CONNECTING')
  const [wsLatency, setWsLatency] = useState<number | null>(null)
  const [tuning, setTuning] = useState<Tuning>(clone(emptyTune))
  const [draft, setDraft] = useState<Tuning>(clone(emptyTune))
  const [events, setEvents] = useState<LogRow[]>([])
  const [severity, setSeverity] = useState<'ALL' | 'FAULT' | 'STATE' | 'OTHER'>('ALL')
  const [tab, setTab] = useState<'audit' | 'tuning' | 'plot'>('audit')
  const [toast, setToast] = useState<Toast | null>(null)
  const [confirmZero, setConfirmZero] = useState(false)
  const [logLoaded, setLogLoaded] = useState(false)
  const [lastTelemetryAt, setLastTelemetryAt] = useState<number | null>(null)
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [tuneError, setTuneError] = useState('')
  const [logError, setLogError] = useState('')
  const [configLoaded, setConfigLoaded] = useState(false)
  const [activeMotionKeys, setActiveMotionKeys] = useState<Set<string>>(() => new Set())

  const socket = useRef<WebSocket | null>(null)
  const simulatedInputBlockedRef = useRef(false)
  const pingSent = useRef(0)
  const plot = useRef<HTMLCanvasElement | null>(null)
  const history = useRef<{ t: number; x: number; y: number }[]>([])
  const jogTimer = useRef<number | null>(null)
  const jogDirs = useRef({ pan: 0, tilt: 0 })
  const pressedMotionKeys = useRef(new Set<string>())
  const deadmanTimer = useRef<number | null>(null)
  const deadmanRequested = useRef(false)
  const toastTimer = useRef<number | null>(null)

  const notify = useCallback((message: string, tone: Toast['tone'] = 'warn') => {
    setToast({ message, tone })
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 3600)
  }, [])

  const openAuth = useCallback(() => {
    setAuthError('')
    setAuthOpen(true)
  }, [])

  const api = usePrahariApi(token, openAuth)

  const setBusy = useCallback((key: string, value: boolean) => {
    setPending((p) => ({ ...p, [key]: value }))
  }, [])

  const loadTune = useCallback(async () => {
    setConfigLoaded(false)
    try {
      const t = await api.loadConfig()
      setTuning(t)
      setDraft(clone(t))
      setConfigLoaded(true)
      setTuneError('')
    } catch (e) {
      const msg = String((e as Error).message || e)
      setTuneError(msg)
      setConfigLoaded(false)
    }
  }, [api])

  const loadLog = useCallback(async () => {
    try {
      const l = await api.loadLog(200)
      setEvents(l.events || [])
      setLogLoaded(true)
      setLogError('')
    } catch (e) {
      const msg = String((e as Error).message || e)
      setLogError(msg)
    }
  }, [api])

  const backendReady = health !== null
  useEffect(() => {
    if (backendReady) void loadTune()
  }, [backendReady, loadTune])

  useEffect(() => {
    if (!backendReady || logError) return
    void loadLog()
    const id = window.setInterval(() => void loadLog(), 4000)
    return () => window.clearInterval(id)
  }, [backendReady, logError, loadLog])

  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const h = await fetchHealth()
        if (!alive) return
        setHealth(h)
        if (reportsSimulatedInput(h)) {
          simulatedInputBlockedRef.current = true
          setSimulatedInputBlocked(true)
          setTelemetry(null)
        } else {
          simulatedInputBlockedRef.current = false
          setSimulatedInputBlocked(false)
        }
        if (h.auth_required && !getStoredToken()) {
          setLink('TOKEN REQUIRED')
          setAuthOpen(true)
        } else if (link === 'SERVICE OFFLINE') {
          setLink('CONNECTING')
        }
      } catch {
        if (alive) setLink('SERVICE OFFLINE')
      }
    }
    void poll()
    const id = window.setInterval(poll, 3000)
    return () => {
      alive = false
      window.clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const authRequired = health?.auth_required ?? false
  useEffect(() => {
    if (!health) return
    if (authRequired && !token) {
      setLink('TOKEN REQUIRED')
      setAuthOpen(true)
      return
    }
    const url = telemetrySocketUrl(token)
    let ws: WebSocket | null = null
    let pingId: number | undefined
    let reconnectId: number | undefined
    let closed = false

    const connect = () => {
      ws = new WebSocket(url)
      socket.current = ws
      ws.onopen = () => {
        setLink('ONLINE')
        const ping = () => {
          if (ws?.readyState === WebSocket.OPEN) {
            pingSent.current = performance.now()
            ws.send(JSON.stringify({ type: 'ping', ts: pingSent.current }))
          }
        }
        ping()
        pingId = window.setInterval(ping, 1000)
      }
      ws.onmessage = (event) => {
        try {
          const d = JSON.parse(event.data)
          if (d.type === 'pong') {
            setWsLatency(Math.max(0, performance.now() - d.ts))
            return
          }
          const t = (d.type === 'telemetry' && d.data ? d.data : d) as Telemetry
          if (reportsSimulatedInput(t) || simulatedInputBlockedRef.current) {
            simulatedInputBlockedRef.current = true
            setSimulatedInputBlocked(true)
            setTelemetry(null)
            return
          }
          setTelemetry(t)
          setLastTelemetryAt(Date.now())
          const now = Date.now()
          history.current.push({ t: now, x: Number(t.err_x) || 0, y: Number(t.err_y) || 0 })
          history.current = history.current.filter((p) => now - p.t <= 10000)
          if (t.interlocks?.estop) setLink('E-STOP LATCHED')
          else if (t.throttled || t.fault) setLink('FAULT')
          else setLink('ONLINE')
        } catch {
          // Ignore malformed telemetry frames.
        }
      }
      ws.onerror = () => setLink('LINK ERROR')
      ws.onclose = () => {
        if (pingId) window.clearInterval(pingId)
        pingId = undefined
        setLink((current) => (current === 'E-STOP LATCHED' || current === 'FAULT' ? current : 'DISCONNECTED'))
        if (!closed) reconnectId = window.setTimeout(connect, 1500)
      }
    }
    connect()

    return () => {
      if (pingId) window.clearInterval(pingId)
      if (reconnectId) window.clearTimeout(reconnectId)
      closed = true
      ws?.close()
      if (socket.current === ws) socket.current = null
    }
  }, [authRequired, token])

  useEffect(() => {
    if (token) storeToken(token)
  }, [token])

  const [nowTick, setNowTick] = useState(Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  const stale = lastTelemetryAt != null && nowTick - lastTelemetryAt > 2500
  const cameraAvailable = telemetry?.camera?.available ?? !!health?.camera.available
  const isEStop = !!telemetry?.interlocks.estop
  const underVolt = !!telemetry?.throttled
  const fault = telemetry?.fault
  const axesCalibrated = !!telemetry?.axes.pan.calibrated && !!telemetry?.axes.tilt.calibrated
  const hardwareInputReady = !!health && !simulatedInputBlocked && cameraAvailable
  const modeAllowed = hardwareInputReady && axesCalibrated && !isEStop && !fault
  const motionAllowed = modeAllowed && telemetry?.state === 'ARMED' && telemetry?.mode === 'manual'
  const locked = telemetry?.state === 'LOCKED'
  const deadmanAllowed = hardwareInputReady && !stale && link === 'ONLINE' &&
    telemetry?.mode === 'auto' && telemetry.interlocks.arm_enabled && !isEStop && !fault

  const stopDeadman = useCallback(() => {
    if (deadmanTimer.current) {
      window.clearInterval(deadmanTimer.current)
      deadmanTimer.current = null
    }
    if (!deadmanRequested.current) return
    deadmanRequested.current = false
    void api.setDeadman(false).catch((e) => {
      notify(`Could not release dead-man input: ${String((e as Error).message || e)}`, 'err')
    })
  }, [api, notify])

  const startDeadman = useCallback(() => {
    if (!deadmanAllowed || deadmanTimer.current) return
    deadmanRequested.current = true
    const heartbeat = () => {
      void api.setDeadman(true).catch((e) => {
        notify(`Dead-man heartbeat failed: ${String((e as Error).message || e)}`, 'err')
        stopDeadman()
      })
    }
    heartbeat()
    deadmanTimer.current = window.setInterval(heartbeat, 100)
  }, [api, deadmanAllowed, notify, stopDeadman])

  useEffect(() => {
    if (!deadmanAllowed) stopDeadman()
  }, [deadmanAllowed, stopDeadman])

  useEffect(() => () => {
    if (deadmanTimer.current) window.clearInterval(deadmanTimer.current)
    if (deadmanRequested.current) void api.setDeadman(false).catch(() => {})
  }, [api])

  const videoUrl = useMemo(() => withTokenQuery('/video', token), [token])

  const estopAction = useCallback(async () => {
    stopDeadman()
    setBusy('estop', true)
    try {
      await api.estop()
      notify('E-STOP latched. Actuator outputs commanded off.', 'warn')
      setLink('E-STOP LATCHED')
    } catch {
      notify('E-STOP request failed. Use physical motor power cut.', 'err')
    } finally {
      setBusy('estop', false)
    }
  }, [api, notify, setBusy, stopDeadman])

  const stopJogRef = useRef<() => void>(() => {})
  const sendJog = useCallback(() => {
    if (!motionAllowed) return
    const d = jogDirs.current
    void api.jog(d.pan * 20, d.tilt * 15).catch((e) => {
      notify(String((e as Error).message || e), 'err')
      stopJogRef.current()
    })
  }, [motionAllowed, api, notify])

  const stopJogCommand = useCallback(() => {
    if (jogTimer.current) {
      window.clearInterval(jogTimer.current)
      jogTimer.current = null
    }
    const wasMoving = jogDirs.current.pan !== 0 || jogDirs.current.tilt !== 0
    jogDirs.current = { pan: 0, tilt: 0 }
    if (wasMoving) void api.jog(0, 0).catch(() => {})
  }, [api])
  const stopJog = useCallback(() => {
    pressedMotionKeys.current.clear()
    setActiveMotionKeys(new Set())
    stopJogCommand()
  }, [stopJogCommand])
  stopJogRef.current = stopJog

  useEffect(() => {
    if (!motionAllowed) stopJog()
  }, [motionAllowed, stopJog])

  useEffect(() => {
    const movementKeys = new Set(['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'a', 'd', 'w', 's'])
    const syncJog = () => {
      if (!motionAllowed) {
        stopJog()
        return
      }
      const keys = pressedMotionKeys.current
      setActiveMotionKeys(new Set(keys))
      const pan = Number(keys.has('d') || keys.has('arrowright')) - Number(keys.has('a') || keys.has('arrowleft'))
      const tilt = Number(keys.has('w') || keys.has('arrowup')) - Number(keys.has('s') || keys.has('arrowdown'))
      if (pan === 0 && tilt === 0) {
        stopJogCommand()
        return
      }
      jogDirs.current = { pan, tilt }
      if (!jogTimer.current) {
        sendJog()
        jogTimer.current = window.setInterval(sendJog, 100)
      }
    }
    const key = (e: KeyboardEvent) => {
      if (isTypingTarget(document.activeElement)) return
      if (e.code === 'Escape' || e.code === 'Space') {
        e.preventDefault()
        if (!e.repeat) void estopAction()
        return
      }
      const keyName = e.key.toLowerCase()
      if (movementKeys.has(keyName) && motionAllowed) {
        e.preventDefault()
        if (!e.repeat) {
          pressedMotionKeys.current.add(keyName)
          syncJog()
        }
      }
    }
    const up = (e: KeyboardEvent) => {
      const keyName = e.key.toLowerCase()
      if (movementKeys.has(keyName)) {
        pressedMotionKeys.current.delete(keyName)
        syncJog()
      }
    }
    window.addEventListener('keydown', key)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', stopJog)
    return () => {
      window.removeEventListener('keydown', key)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', stopJog)
    }
  }, [motionAllowed, sendJog, stopJog, stopJogCommand, estopAction])

  async function onSetMode(mode: Mode) {
    stopDeadman()
    if (mode !== 'idle') stopJog()
    setBusy(`mode-${mode}`, true)
    try {
      await api.setMode(mode)
      notify(`Mode command accepted: ${MODE_LABEL[mode]}`, 'ok')
    } catch (e) {
      notify(String((e as Error).message || e), 'err')
    } finally {
      setBusy(`mode-${mode}`, false)
    }
  }

  async function calibrate() {
    if (!confirmZero) {
      setConfirmZero(true)
      window.setTimeout(() => setConfirmZero(false), 4000)
      return
    }
    setConfirmZero(false)
    setBusy('calibrate', true)
    try {
      await api.calibrate()
      notify('Current axis positions recorded as zero.', 'ok')
    } catch (e) {
      notify(String((e as Error).message || e), 'err')
    } finally {
      setBusy('calibrate', false)
    }
  }

  async function home() {
    setBusy('home', true)
    try {
      await api.home()
      notify('Homing complete.', 'ok')
    } catch (e) {
      notify(String((e as Error).message || e), 'err')
    } finally {
      setBusy('home', false)
    }
  }

  async function applyConfig() {
    setBusy('config', true)
    try {
      const t = await api.saveConfig({
        ...draft,
        color: {
          hue_min: +draft.color.hue_min,
          hue_max: +draft.color.hue_max,
          saturation_min: +draft.color.saturation_min,
          value_min: +draft.color.value_min,
        },
        control: {
          kp: +draft.control.kp,
          ki: +draft.control.ki,
          kd: +draft.control.kd,
        },
      })
      setTuning(t)
      setDraft(clone(t))
      setTuneError('')
      notify('Configuration applied.', 'ok')
    } catch (e) {
      const msg = String((e as Error).message || e)
      setTuneError(msg)
      notify(msg, 'err')
    } finally {
      setBusy('config', false)
    }
  }

  const filtered = events
    .filter((row) =>
      severity === 'ALL'
        ? true
        : severity === 'FAULT'
          ? row.event === 'fault' || row.event === 'estop'
          : severity === 'STATE'
            ? row.event === 'state'
            : row.event !== 'state' && row.event !== 'fault' && row.event !== 'estop',
    )
    .slice()
    .reverse()

  function copyDiagnostics() {
    const payload = { health, telemetry, events: events.slice(-30), captured: new Date().toISOString() }
    navigator.clipboard
      ?.writeText(JSON.stringify(payload, null, 2))
      .then(() => notify('Diagnostics copied.', 'ok'))
      .catch(() => notify('Clipboard unavailable.', 'err'))
  }

  useEffect(() => {
    const c = plot.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    const rect = c.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    c.width = Math.max(1, Math.floor(rect.width * dpr))
    c.height = Math.max(1, Math.floor(rect.height * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const w = rect.width
    const h = rect.height
    ctx.fillStyle = '#0b1014'
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = '#23303a'
    ctx.lineWidth = 1
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.fillStyle = '#71818d'
    for (let i = 0; i <= 4; i++) {
      const y = 20 + (i * (h - 36)) / 4
      ctx.beginPath()
      ctx.moveTo(38, y)
      ctx.lineTo(w - 10, y)
      ctx.stroke()
      ctx.fillText(String(100 - i * 50), 4, y + 3)
    }
    for (let i = 0; i <= 5; i++) {
      const x = 38 + (i * (w - 48)) / 5
      ctx.beginPath()
      ctx.moveTo(x, 12)
      ctx.lineTo(x, h - 16)
      ctx.stroke()
      ctx.fillText(`${10 - i * 2}s`, x - 10, h - 4)
    }
    const points = history.current
    if (points.length < 2) return
    const tmax = Date.now()
    const tmin = tmax - 10000
    for (const line of [
      { key: 'x' as const, color: '#4fd1a5' },
      { key: 'y' as const, color: '#58c7dd' },
    ]) {
      ctx.strokeStyle = line.color
      ctx.lineWidth = 1.75
      ctx.beginPath()
      let started = false
      for (const p of points) {
        const x = 38 + ((p.t - tmin) / 10000) * (w - 48)
        const value = Math.max(-100, Math.min(100, p[line.key]))
        const y = 20 + ((100 - value) / 200) * (h - 36)
        if (!started) {
          ctx.moveTo(x, y)
          started = true
        } else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
  }, [telemetry, tab])

  const banner = isEStop
    ? 'E-STOP LATCHED — actuator outputs commanded off. Resolve cause, then disarm/reset workflow as supported by backend.'
    : underVolt
      ? 'PI POWER/THERMAL FAULT — get_throttled reports undervoltage or throttling.'
      : fault
        ? `FAULT — ${fault}`
        : stale
          ? 'TELEMETRY STALE — last update exceeded 2.5s; display may be out of date.'
            : simulatedInputBlocked
              ? 'INPUT REJECTED — this service reports simulated data. Connect the physical camera and hardware service.'
              : ''

  const throttleHex = health?.throttle_flags_hex ?? telemetry?.throttle_flags_hex ?? 'NOT EXPOSED'
  const piHealth = throttleHex === 'NOT EXPOSED' ? 'UNKNOWN' : underVolt ? 'THROTTLED' : 'NOMINAL'
  const connectionTone =
    link === 'ONLINE' ? 'ok' : link === 'E-STOP LATCHED' || link === 'FAULT' || link === 'SERVICE OFFLINE' ? 'bad' : 'warn'

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <header className="topbar" role="banner">
        <div className="brand">
          <img src="/brand/emblem.png" alt="" className="brand-logo" aria-hidden="true" />
          <div>
            <div className="brand-title">PRAHARI-E.O.</div>
            <div className="brand-sub">VISION TRACKING SYSTEM</div>
          </div>
        </div>
        <div className="status-cluster" aria-label="System status">
          <StatusPill tone={connectionTone} icon={<Wifi size={13} />} label="LINK" value={link} />
          <StatusPill tone={simulatedInputBlocked ? 'bad' : !health ? 'warn' : 'ok'} label="PLATFORM" value={simulatedInputBlocked ? 'INPUT REJECTED' : !health ? 'WAITING' : 'HARDWARE'} />
          <StatusPill tone={isEStop ? 'bad' : fault ? 'bad' : locked ? 'ok' : 'warn'} label="STATE" value={telemetry?.state ?? health?.state ?? 'UNKNOWN'} />
          <StatusPill tone={telemetry?.mode === 'auto' ? 'ok' : 'neutral'} label="MODE" value={telemetry?.mode?.toUpperCase() ?? '--'} />
          <StatusPill tone={underVolt ? 'bad' : 'neutral'} label="PI HEALTH" value={piHealth} detail={`FLAGS ${throttleHex}`} />
          <StatusPill tone="neutral" label="WS RTT" value={wsLatency == null ? '--' : `${wsLatency.toFixed(0)} ms`} />
        </div>
        <button className="estop-btn" onClick={() => void estopAction()} disabled={!!pending.estop} aria-label="Emergency stop">
          {pending.estop ? <LoaderCircle size={15} className="spin" /> : <CircleStop size={15} />}
          E-STOP
        </button>
      </header>

      <div className="health-strip" aria-label="Health summary">
        <Metric label="Camera" value={simulatedInputBlocked ? 'REJECTED' : !health ? 'WAITING' : cameraAvailable ? 'READY' : 'OFFLINE'} tone={simulatedInputBlocked ? 'bad' : cameraAvailable ? 'ok' : 'warn'} detail={simulatedInputBlocked ? 'Connect physical camera/hardware service' : !health ? 'No service data' : cameraAvailable ? 'Camera input available' : health.camera.error ?? 'No fresh camera frames'} />
        <Metric label="Calibration" value={!telemetry ? 'WAITING' : axesCalibrated ? 'CALIBRATED' : 'ZERO REQUIRED'} tone={axesCalibrated ? 'ok' : 'warn'} detail={telemetry ? `PAN ${telemetry.axes.pan.calibrated ? 'OK' : 'NO'} / TILT ${telemetry.axes.tilt.calibrated ? 'OK' : 'NO'}` : 'No axis data'} />
        <Metric label="FPS" value={fmt(telemetry?.fps, 1)} tone="neutral" />
        <Metric label="Latency" value={`${fmt(telemetry?.latency_ms, 0)} ms`} tone="neutral" />
        <Metric label="CPU Temp" value={telemetry?.cpu_temp_c == null && health?.cpu_temp_c == null ? '--' : `${fmt(telemetry?.cpu_temp_c ?? health?.cpu_temp_c, 1)} C`} tone={underVolt ? 'bad' : 'neutral'} />
        <Metric label="Target" value={!health || !telemetry ? 'WAITING' : !health.camera.available ? 'CAMERA OFFLINE' : telemetry.target ? (locked ? 'LOCKED' : 'ACQUIRED') : 'NO TARGET'} tone={telemetry?.target ? (locked ? 'ok' : 'warn') : 'neutral'} detail={telemetry?.target ? `conf ${fmt(telemetry.target.conf, 2)}` : '--'} />
      </div>

      <main id="main-content" className="workspace">
        <CameraViewport
          health={health}
          telemetry={telemetry}
          videoUrl={videoUrl}
          banner={banner}
          bannerBad={isEStop || !!fault || underVolt}
          axesCalibrated={axesCalibrated}
          link={link}
          inputBlocked={simulatedInputBlocked}
        />

        <aside className="side-stack">
          <section className="panel" aria-labelledby="motion-title">
            <PanelHead kicker="OPERATOR STATION" title="Motion Control" id="motion-title">
              <div className={`state-chip ${isEStop || fault ? 'bad' : locked ? 'ok' : 'warn'}`}>{telemetry?.state || 'LINK WAIT'}</div>
            </PanelHead>
            <div className="panel-body">
              <div className="field">
                <div className="field-label">Operating mode</div>
                <div className="segmented" role="group" aria-label="Operating mode">
                  {(['idle', 'manual', 'auto'] as Mode[]).map((mode) => {
                    const selected = mode === 'idle' ? telemetry?.state === 'SAFE' : mode === 'manual' ? telemetry?.mode === 'manual' && telemetry?.state !== 'SAFE' : telemetry?.mode === 'auto'
                    const disabled = mode === 'idle' ? !health : !modeAllowed
                    return (
                      <button key={mode} className={selected ? 'selected' : ''} disabled={disabled || !!pending[`mode-${mode}`]} onClick={() => void onSetMode(mode)}>
                        {pending[`mode-${mode}`] ? <LoaderCircle size={13} className="spin" /> : MODE_LABEL[mode]}
                      </button>
                    )
                  })}
                </div>
                <p className="help-text">
                  {!health ? 'Waiting for the hardware service.' : !telemetry ? 'Waiting for live axis telemetry.' : motionAllowed ? 'Manual jog active. Hold controls to move; release to stop.' : modeAllowed ? 'Select MANUAL for jog or AUTO for tracking.' : 'Calibrate both axes and clear faults/E-STOP before motion modes.'}
                </p>
              </div>

              <div className={`field keyboard-control ${motionAllowed ? 'is-ready' : ''}`} aria-label="Keyboard pan and tilt control">
                <div className="field-label-row">
                  <div className="field-label">Keyboard control</div>
                  <div className="muted-small">{motionAllowed ? 'HOLD TO MOVE' : 'LOCKED'}</div>
                </div>
                <div className="key-control-layout">
                  <div className="key-control-cluster wasd-cluster" aria-label="WASD controls">
                    <kbd className={`keycap ${activeMotionKeys.has('w') ? 'is-active' : ''}`}>W</kbd>
                    <div className="keycap-row">
                      <kbd className={`keycap ${activeMotionKeys.has('a') ? 'is-active' : ''}`}>A</kbd>
                      <kbd className={`keycap ${activeMotionKeys.has('s') ? 'is-active' : ''}`}>S</kbd>
                      <kbd className={`keycap ${activeMotionKeys.has('d') ? 'is-active' : ''}`}>D</kbd>
                    </div>
                  </div>
                  <div className="key-control-divider" aria-hidden="true" />
                  <div className="key-control-cluster arrow-cluster" aria-label="Arrow key controls">
                    <kbd className={`keycap ${activeMotionKeys.has('arrowup') ? 'is-active' : ''}`}>↑</kbd>
                    <div className="keycap-row">
                      <kbd className={`keycap ${activeMotionKeys.has('arrowleft') ? 'is-active' : ''}`}>←</kbd>
                      <kbd className={`keycap ${activeMotionKeys.has('arrowdown') ? 'is-active' : ''}`}>↓</kbd>
                      <kbd className={`keycap ${activeMotionKeys.has('arrowright') ? 'is-active' : ''}`}>→</kbd>
                    </div>
                  </div>
                  <div className="key-control-labels">
                    <span><strong>W / ↑</strong> Tilt up</span>
                    <span><strong>S / ↓</strong> Tilt down</span>
                    <span><strong>A / ←</strong> Pan left</span>
                    <span><strong>D / →</strong> Pan right</span>
                  </div>
                </div>
                <p className="help-text">Hold a direction to move. Release to stop. Opposing directions cancel; movement is available only in calibrated MANUAL mode.</p>
              </div>

              <div className="field action-grid">
                <button className={`btn ${confirmZero ? 'btn-warn' : 'btn-secondary'}`} onClick={() => void calibrate()} disabled={!telemetry || telemetry.interlocks.arm_enabled || isEStop || !!pending.calibrate}>
                  {pending.calibrate ? <LoaderCircle size={14} className="spin" /> : confirmZero ? <AlertTriangle size={14} /> : <Radar size={14} />}
                  {confirmZero ? 'CONFIRM ZERO' : 'SET CURRENT ZERO'}
                </button>
                <button className="btn btn-secondary" onClick={() => void home()} disabled={!health?.home_switches_enabled || telemetry?.interlocks.arm_enabled || isEStop || !!pending.home} title={health?.home_switches_enabled ? 'Home both axes' : 'Homing switches not enabled in backend'}>
                  {pending.home ? <LoaderCircle size={14} className="spin" /> : <Home size={14} />} HOME AXES
                </button>
              </div>
              {health && !health.home_switches_enabled && <p className="help-text">Homing unavailable: `home_switches_enabled` is false in backend config.</p>}
              <div className="kbd-note"><Keyboard size={13} /> Space/Esc = E-STOP. Keyboard jog disabled while typing in inputs.</div>
            </div>
          </section>

          <section className="panel" aria-labelledby="telemetry-title">
            <PanelHead kicker="LIVE TELEMETRY" title="System Health" id="telemetry-title">
              <span className={`state-chip ${stale || !telemetry ? 'warn' : 'ok'}`}>
                {!telemetry ? 'WAITING' : stale ? 'STALE' : 'LIVE'}
              </span>
            </PanelHead>
            <div className="panel-body telemetry-grid">
              <TelemetryRow label="Pan estimate" value={telemetry?.axes.pan.calibrated ? `${fmt(telemetry.axes.pan.deg, 2)}°` : '--'} detail={`cmd ${fmt(telemetry?.axes.pan.velocity_dps, 1)} dps`} />
              <TelemetryRow label="Tilt estimate" value={telemetry?.axes.tilt.calibrated ? `${fmt(telemetry.axes.tilt.deg, 2)}°` : '--'} detail={`cmd ${fmt(telemetry?.axes.tilt.velocity_dps, 1)} dps`} />
              <TelemetryRow label="Angular err" value={`${fmt(telemetry?.angular_error_deg?.pan, 2)}° / ${fmt(telemetry?.angular_error_deg?.tilt, 2)}°`} />
              <TelemetryRow label="Deadman" value={!telemetry ? '--' : telemetry.interlocks.deadman ? 'HELD' : 'OFF'} />
              <TelemetryRow label="Buzzer cue" value={!health ? '--' : health.buzzer_enabled ? 'ENABLED' : 'DISABLED'} detail={health ? 'Backend-configured' : undefined} />
              <TelemetryRow label="CPU / Throttle" value={telemetry?.cpu_temp_c == null && health?.cpu_temp_c == null ? '--' : `${fmt(telemetry?.cpu_temp_c ?? health?.cpu_temp_c, 1)} C`} detail={piHealth} tone={underVolt ? 'bad' : undefined} />
              <div className="deadman-control">
                <button
                  className={`btn ${telemetry?.interlocks.deadman ? 'btn-warn' : 'btn-secondary'}`}
                  type="button"
                  disabled={!deadmanAllowed}
                  aria-pressed={!!telemetry?.interlocks.deadman}
                  onPointerDown={(event) => {
                    event.preventDefault()
                    event.currentTarget.setPointerCapture(event.pointerId)
                    startDeadman()
                  }}
                  onPointerUp={stopDeadman}
                  onPointerCancel={stopDeadman}
                  onLostPointerCapture={stopDeadman}
                  onKeyDown={(event) => {
                    if (event.code === 'Space') {
                      event.preventDefault()
                      event.stopPropagation()
                      startDeadman()
                    }
                  }}
                  onKeyUp={(event) => {
                    if (event.code === 'Space') {
                      event.preventDefault()
                      event.stopPropagation()
                      stopDeadman()
                    }
                  }}
                  onBlur={stopDeadman}
                >
                  {telemetry?.interlocks.deadman ? 'RELEASE TO DISENGAGE' : 'HOLD FOR TARGET LOCK'}
                </button>
                <p className="help-text">Available in AUTO. The input expires automatically when released or disconnected.</p>
              </div>
            </div>
          </section>
        </aside>

        <section className="panel config-panel" aria-labelledby="config-title">
          <PanelHead kicker="DETECTOR / CONTROL" title="Configuration" id="config-title">
            <div className="panel-meta"><span>{configLoaded ? 'Loaded from backend' : tuneError ? 'Unavailable' : 'Waiting for backend'}</span></div>
          </PanelHead>
          <div className="panel-body">
            {configLoaded ? <div className="config-grid">
              <label className="field">Detector
                <div className="select-wrap">
                  <select value={draft.backend} onChange={(e) => setDraft({ ...draft, backend: e.target.value })} aria-label="Detector backend">
                    <option value="color">COLOR / RED MARKER</option>
                    <option value="aruco">ARUCO MARKER</option>
                    <option value="motion">MOTION / FRAME DIFF</option>
                  </select>
                  <ChevronDown size={14} />
                </div>
              </label>
              <NumberField label="Hue min" min={0} max={179} value={draft.color.hue_min} onChange={(v) => setDraft({ ...draft, color: { ...draft.color, hue_min: v } })} />
              <NumberField label="Hue max" min={0} max={179} value={draft.color.hue_max} onChange={(v) => setDraft({ ...draft, color: { ...draft.color, hue_max: v } })} />
              <NumberField label="Sat min" min={0} max={255} value={draft.color.saturation_min} onChange={(v) => setDraft({ ...draft, color: { ...draft.color, saturation_min: v } })} />
              <NumberField label="Value min" min={0} max={255} value={draft.color.value_min} onChange={(v) => setDraft({ ...draft, color: { ...draft.color, value_min: v } })} />
              <NumberField label="PID Kp" min={0} max={2} step={0.01} value={draft.control.kp} onChange={(v) => setDraft({ ...draft, control: { ...draft.control, kp: v } })} />
              <NumberField label="PID Ki" min={0} max={1} step={0.01} value={draft.control.ki} onChange={(v) => setDraft({ ...draft, control: { ...draft.control, ki: v } })} />
              <NumberField label="PID Kd" min={0} max={1} step={0.01} value={draft.control.kd} onChange={(v) => setDraft({ ...draft, control: { ...draft.control, kd: v } })} />
            </div> : <div className="empty-state">{tuneError || 'Waiting for live configuration from the service.'}</div>}
            {tuneError && <div className="inline-error" role="status"><AlertTriangle size={14} /> {tuneError}</div>}
            <div className="config-actions">
              {tuneError && <button className="btn btn-secondary" onClick={() => void loadTune()} disabled={!!pending.config}><RefreshCw size={14} /> RETRY</button>}
              <button className="btn btn-secondary" onClick={() => { setDraft(clone(tuning)); setTuneError('') }} disabled={!configLoaded || !!pending.config}><RotateCcw size={14} /> REVERT DRAFT</button>
              <button className="btn btn-primary" onClick={() => void applyConfig()} disabled={!configLoaded || !!pending.config}>{pending.config ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />} APPLY CONFIG</button>
            </div>
          </div>
        </section>

        <section className="panel log-panel" aria-labelledby="log-title">
          <PanelHead kicker="AUDIT / TELEMETRY" title="Events & Diagnostics" id="log-title">
            <div className="panel-meta"><span>{logLoaded ? `${events.length} events` : 'Waiting for events'}</span><span className={logError ? 'tone-warn' : logLoaded ? 'tone-ok' : ''}>{logError ? 'Log error' : logLoaded ? 'Log synced' : 'Waiting'}</span></div>
          </PanelHead>
          <div className="tabs" role="tablist" aria-label="Diagnostics tabs">
            <button role="tab" aria-selected={tab === 'audit'} className={tab === 'audit' ? 'active' : ''} onClick={() => setTab('audit')}><TerminalSquare size={14} /> EVENT AUDIT</button>
            <button role="tab" aria-selected={tab === 'tuning'} className={tab === 'tuning' ? 'active' : ''} onClick={() => setTab('tuning')}><SlidersHorizontal size={14} /> PID & DETECTOR</button>
            <button role="tab" aria-selected={tab === 'plot'} className={tab === 'plot' ? 'active' : ''} onClick={() => setTab('plot')}><SquareActivity size={14} /> ERROR PLOT</button>
          </div>
          <div className="tab-body">
            {tab === 'audit' && (
              <div className="audit-pane">
                <div className="audit-tools">
                  <div className="filter-pills" role="group" aria-label="Event severity filter">
                    {(['ALL', 'FAULT', 'STATE', 'OTHER'] as const).map((f) => (
                      <button key={f} className={severity === f ? 'chosen' : ''} onClick={() => setSeverity(f)}>{f}</button>
                    ))}
                  </div>
                  {logError && <button className="btn btn-secondary btn-small" onClick={() => void loadLog()}><RefreshCw size={13} /> RETRY LOG</button>}
                  <button className="btn btn-secondary btn-small" onClick={copyDiagnostics}><ClipboardCopy size={13} /> COPY DIAGNOSTICS</button>
                </div>
                {logError && <div className="inline-error"><AlertTriangle size={14} /> {logError}</div>}
                <div className="audit-list" role="log" aria-live="polite">
                  {filtered.length ? filtered.map((row, i) => (
                    <div className="audit-row" key={`${row.time}-${row.event}-${i}`}>
                      <time>{new Date(row.time * 1000).toLocaleTimeString()}</time>
                      <span className={`event-level ${row.event === 'fault' || row.event === 'estop' ? 'bad' : row.event === 'state' ? 'warn' : 'ok'}`}>{row.event === 'fault' || row.event === 'estop' ? 'CRIT' : row.event === 'state' ? 'STATE' : 'INFO'}</span>
                      <strong>{row.event.replaceAll('_', ' ').toUpperCase()}</strong>
                      <span className="event-detail">{Object.entries(row).filter(([k]) => !['time', 'event'].includes(k)).map(([k, v]) => `${k}=${String(v)}`).join(' · ')}</span>
                    </div>
                  )) : <div className="empty-state"><Database size={15} /> {logLoaded ? 'No audit events returned by service.' : 'Waiting for live audit data.'}</div>}
                </div>
              </div>
            )}
            {tab === 'tuning' && (
              <div className="tuning-pane">
                <p className="help-text">Values load from `/api/config` and save through `PUT /api/config` using the existing contract. Color fields apply to color backend; PID applies to tracking control.</p>
                {configLoaded ? <div className="config-grid compact">
                  <NumberField label="Hue min" min={0} max={179} value={draft.color.hue_min} onChange={(v) => setDraft({ ...draft, color: { ...draft.color, hue_min: v } })} />
                  <NumberField label="Hue max" min={0} max={179} value={draft.color.hue_max} onChange={(v) => setDraft({ ...draft, color: { ...draft.color, hue_max: v } })} />
                  <NumberField label="Sat min" min={0} max={255} value={draft.color.saturation_min} onChange={(v) => setDraft({ ...draft, color: { ...draft.color, saturation_min: v } })} />
                  <NumberField label="Value min" min={0} max={255} value={draft.color.value_min} onChange={(v) => setDraft({ ...draft, color: { ...draft.color, value_min: v } })} />
                  <NumberField label="Kp" min={0} max={2} step={0.01} value={draft.control.kp} onChange={(v) => setDraft({ ...draft, control: { ...draft.control, kp: v } })} />
                  <NumberField label="Ki" min={0} max={1} step={0.01} value={draft.control.ki} onChange={(v) => setDraft({ ...draft, control: { ...draft.control, ki: v } })} />
                  <NumberField label="Kd" min={0} max={1} step={0.01} value={draft.control.kd} onChange={(v) => setDraft({ ...draft, control: { ...draft.control, kd: v } })} />
                  <label className="field">Backend
                    <div className="select-wrap"><select value={draft.backend} onChange={(e) => setDraft({ ...draft, backend: e.target.value })}><option value="color">COLOR</option><option value="aruco">ARUCO</option><option value="motion">MOTION</option></select><ChevronDown size={14} /></div>
                  </label>
                </div> : <div className="empty-state">{tuneError || 'Waiting for live configuration from the service.'}</div>}
                <div className="config-actions">
                  {tuneError && <button className="btn btn-secondary" onClick={() => void loadTune()} disabled={!!pending.config}><RefreshCw size={14} /> RETRY</button>}
                  <button className="btn btn-secondary" onClick={() => setDraft(clone(tuning))} disabled={!configLoaded || !!pending.config}><RefreshCw size={14} /> REVERT</button>
                  <button className="btn btn-primary" onClick={() => void applyConfig()} disabled={!configLoaded || !!pending.config}>{pending.config ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />} APPLY</button>
                </div>
              </div>
            )}
            {tab === 'plot' && (
              <div className="plot-pane">
                <div className="plot-legend"><span><i className="legend-x" /> ΔX px</span><span><i className="legend-y" /> ΔY px</span><span className="muted-small">10s window / live telemetry</span></div>
                <canvas ref={plot} aria-label="Pixel error plot" role="img" />
              </div>
            )}
          </div>
        </section>
      </main>

      {authOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="auth-title">
          <form className="modal" onSubmit={(e) => {
            e.preventDefault()
            const t = tokenDraft.trim()
            if (!t) { setAuthError('Enter PRAHARI_TOKEN'); return }
            setToken(t)
            storeToken(t)
            setAuthOpen(false)
            setAuthError('')
            setLink('CONNECTING')
          }}>
            <div className="kicker">HARDWARE SESSION</div>
            <h2 id="auth-title">Operator authentication</h2>
            <p>Enter the local PRAHARI token to access telemetry, config, logs and protected video/WS channels.</p>
            <label className="field">PRAHARI_TOKEN
              <input autoFocus type="password" autoComplete="current-password" value={tokenDraft} onChange={(e) => setTokenDraft(e.target.value)} placeholder="Token" />
            </label>
            {authError && <div className="inline-error"><AlertTriangle size={14} /> {authError}</div>}
            <div className="config-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setAuthOpen(false)}>CLOSE</button>
              <button type="submit" className="btn btn-primary">CONNECT</button>
            </div>
          </form>
        </div>
      )}

      {toast && (
        <div className={`toast toast-${toast.tone}`} role="status" aria-live="polite">
          {toast.tone === 'ok' ? <Check size={14} /> : <AlertTriangle size={14} />}
          <span>{toast.message}</span>
          <button onClick={() => setToast(null)} aria-label="Dismiss notification"><X size={13} /></button>
        </div>
      )}
    </div>
  )
}

function PanelHead({ kicker, title, id, children }: { kicker: string; title: string; id: string; children?: ReactNode }) {
  return (
    <div className="panel-head">
      <div>
        <div className="kicker">{kicker}</div>
        <h2 id={id}>{title}</h2>
      </div>
      {children}
    </div>
  )
}

function StatusPill({ tone, icon, label, value, detail }: { tone: 'ok' | 'warn' | 'bad' | 'neutral'; icon?: React.ReactNode; label: string; value: string; detail?: string }) {
  return (
    <div className={`status-pill tone-${tone}`}>
      <span className="status-label">{icon}{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  )
}

function Metric({ label, value, tone, detail }: { label: string; value: string; tone: 'ok' | 'warn' | 'bad' | 'neutral'; detail?: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong className={`tone-${tone}`}>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  )
}

function TelemetryRow({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: 'bad' }) {
  return (
    <div className="telemetry-row">
      <span>{label}</span>
      <div>
        <strong className={tone ? `tone-${tone}` : ''}>{value}</strong>
        {detail && <small>{detail}</small>}
      </div>
    </div>
  )
}

function NumberField({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return (
    <label className="field">{label}
      <input type="number" min={min} max={max} step={step ?? 1} value={value} onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))} />
    </label>
  )
}
