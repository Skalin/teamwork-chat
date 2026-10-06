import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TwConversation, TwFile, TwMessage, TwPastedImage, TwPerson, TwPicture, TwView } from '../types'

export type Platform = 'wsl' | 'windows' | 'unix'
export type PictureMode = 'image' | 'mosaic' | 'off'
type Env = Record<string, string | undefined>

const SERVER = 'claude_ai_Teamwork_com'
const PANE = 'teamwork-chat'
const POLL_MS = 30_000
const RETRY_MS = 5_000 // while the Teamwork connector is still connecting
const CONV_POLL_MS = 5_000 // an open conversation fetches its newest messages this often
const CONV_IDLE_MS = 5 * 60_000 // and goes back to the list after this long without activity
const PAGES = 3 // list_conversations returns at most 10 per page

const convs = atom({ plugin: 'teamwork-chat', key: 'convs' } as const, [])
const seen = atom({ plugin: 'teamwork-chat', key: 'seen' } as const, {})
const me = atom({ plugin: 'teamwork-chat', key: 'me' } as const, null)
const view = atom({ plugin: 'teamwork-chat', key: 'view' } as const, { mode: 'all' })
const messages = atom({ plugin: 'teamwork-chat', key: 'messages' } as const, [])
const people = atom({ plugin: 'teamwork-chat', key: 'people' } as const, [])
const error = atom({ plugin: 'teamwork-chat', key: 'error' } as const, null)
const isBusy = atom({ plugin: 'teamwork-chat', key: 'isBusy' } as const, false)
const siteUrl = atom({ plugin: 'teamwork-chat', key: 'siteUrl' } as const, null)
const pictures = atom({ plugin: 'teamwork-chat', key: 'pictures' } as const, {})
const suggestion = atom({ plugin: 'teamwork-chat', key: 'suggestion' } as const, null)
const isSuggesting = atom({ plugin: 'teamwork-chat', key: 'isSuggesting' } as const, false)
const replyGeneration = atom({ plugin: 'teamwork-chat', key: 'replyGeneration' } as const, 0)
const hasReplyText = atom({ plugin: 'teamwork-chat', key: 'hasReplyText' } as const, false)
const pasted = atom({ plugin: 'teamwork-chat', key: 'pasted' } as const, null)
const sending = atom({ plugin: 'teamwork-chat', key: 'sending' } as const, null)
const isFocus = atom({ plugin: 'teamwork-chat', key: 'isFocus' } as const, true)
const retryIn = atom({ plugin: 'teamwork-chat', key: 'retryIn' } as const, null)

// Transcript rows hidden in focus mode; the spinner, command output and dialogs stay.
const HIDDEN_ROWS = ['UserMessage', 'AssistantMessage', 'ToolUse', 'ToolResult', 'ToolGroup', 'TurnDuration'] as const
const GOLD = '#d4a017'
const ORANGE = '#ff8c00'
const CLAUDE_COLUMNS = 50 // left for the Claude column beside the docked pane

type $ = EngineInterface
type Json = any

async function tw($: $, tool: string, args: Record<string, unknown> = {}): Promise<Json> {
  const result = await $.mcp.call(SERVER, `twchat-${tool}`, args)
  const text = result.content.map(block => block.text ?? '').join('')
  if (result.isError) throw new Error(text || `${tool} failed`)
  return text ? JSON.parse(text) : {}
}

// Emoji the terminal draws two columns wide (✨, ⌛, ✅ …): the BMP ones with emoji presentation.
const WIDE_BMP = [
  [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
  [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
] as const

// How many terminal columns text takes: wide emoji count two, joiners and variation selectors none.
export function columnsOf(text: string): number {
  let n = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue
    const isWide = cp >= 0x1f000 || WIDE_BMP.some(([lo, hi]) => cp >= lo && cp <= hi)
    n += isWide ? 2 : 1
  }
  return n
}

// Web addresses in a message become real links (OSC 8 on the terminal), so a link that wraps
// over several lines still opens as one; trailing punctuation stays outside it.
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g

export function splitLinks(text: string): Array<string | { href: string }> {
  const parts: Array<string | { href: string }> = []
  let at = 0
  for (const match of text.matchAll(URL_PATTERN)) {
    const href = match[0].replace(/[.,;:!?)\]}]+$/, '')
    const start = match.index ?? 0
    if (start > at) parts.push(text.slice(at, start))
    parts.push({ href })
    at = start + href.length
  }
  if (at < text.length) parts.push(text.slice(at))
  return parts
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, Math.max(1, max - 1)) + '…' : flat
}

// Lowercase without diacritics, so "zdenek kunc" finds "Zdeněk Kunc".
function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

// Today as HH:MM, otherwise D. M.
function when(iso: string): string {
  if (!iso) return ''
  try {
    const zone = { timeZone: 'Europe/Prague' } as const
    const day = (d: Date) => new Intl.DateTimeFormat('cs-CZ', { ...zone, dateStyle: 'short' }).format(d)
    const at = new Date(iso)
    return day(at) === day(new Date())
      ? new Intl.DateTimeFormat('cs-CZ', { ...zone, hour: '2-digit', minute: '2-digit' }).format(at)
      : new Intl.DateTimeFormat('cs-CZ', { ...zone, day: 'numeric', month: 'numeric' }).format(at)
  } catch {
    return iso.slice(5, 10)
  }
}

function kindOf(c: TwConversation): string {
  if (c.type === 'pair') return 'Direct message'
  const members = c.memberCount > 0 ? ` · ${c.memberCount} people` : ''
  return (c.type === 'private' ? 'Group' : 'Channel') + members
}

function iconOf(c: TwConversation): string {
  return c.type === 'pair' ? '👤' : c.type === 'private' ? '👥' : '#'
}

function clock(iso: string): string {
  try {
    return new Intl.DateTimeFormat('cs-CZ', {
      timeZone: 'Europe/Prague',
      day: 'numeric',
      month: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso))
  } catch {
    return iso.slice(5, 16).replace('T', ' ')
  }
}

export function countLabel(n: number): string {
  return n >= 100 ? '99+' : String(Math.max(1, n))
}

// How many messages from others arrived after the last one viewed (at most one page).
async function countUnread($: $, c: TwConversation, viewed: number, myId: number | null): Promise<number> {
  try {
    const r = await tw($, 'list_messages', { conversation_id: c.id, after_message_id: viewed, page_size: 100 })
    return (r.messages ?? []).filter((m: Json) => m.id > viewed && m.author?.id !== myId).length || 1
  } catch {
    return 1
  }
}

export function isUnread(c: TwConversation, seenMap: Record<string, number>, myId: number | null): boolean {
  const viewed = Math.max(c.lastViewedId, seenMap[String(c.id)] ?? 0)
  return c.latestId > viewed && c.latestAuthorId !== myId
}

const names = new Map<number, string>()

async function loadPeople($: $): Promise<void> {
  const cached = (await $.store.get('names')) as Record<string, string> | undefined
  for (const [id, name] of Object.entries(cached ?? {})) names.set(Number(id), name)
  for (let offset = 0; offset < 1000; offset += 50) {
    const page = await tw($, 'list_people', { page_limit: 50, page_offset: offset })
    for (const p of page.people ?? []) names.set(p.id, `${p.firstName} ${p.lastName}`.trim())
    if ((page.people ?? []).length === 0 || offset + 50 >= (page.meta?.page?.total ?? 0)) break
  }
  await $.store.set('names', Object.fromEntries(names))
}

function titleOf(raw: Json, myId: number | null): string {
  if (raw.title) return raw.title
  const others = (raw.people ?? [])
    .map((p: Json) => p.id)
    .filter((id: number) => id !== myId)
    .map((id: number) => names.get(id) ?? `#${id}`)
  return others.join(', ') || 'Conversation'
}

function toConversation(raw: Json, myId: number | null): TwConversation {
  const m = raw.latestMessage ?? {}
  return {
    id: raw.id,
    title: titleOf(raw, myId),
    type: raw.type,
    latestId: m.id ?? 0,
    latestAuthorId: m.author?.id ?? null,
    latestAuthor: m.author?.fullName ?? '',
    latestBody: m.body ?? (m.file?.name ? `[file] ${m.file.name}` : ''),
    latestAt: m.createdAt ?? raw.lastActivityAt ?? '',
    lastViewedId: raw.lastViewedMessageId ?? 0,
    unreadCount: 0,
    memberCount: (raw.people ?? []).length,
  }
}

async function setStatus($: $): Promise<void> {
  const list = await read($, convs)
  const seenMap = await read($, seen)
  const myId = await read($, me)
  const n = list.filter(c => isUnread(c, seenMap, myId)).length
  $.ui.status(n > 0 ? `💬 Teamwork: ${n} unread` : undefined)
}

// The connector comes up a few seconds after the session starts; until then every call fails with this.
export function isNotConnected(err: string | null): boolean {
  return err !== null && err.includes('no connected MCP tool')
}

export function errorLine(err: string | null, seconds: number | null): string | null {
  if (!isNotConnected(err)) return err
  return seconds ? `Teamwork: connecting… retrying in ${seconds}s` : 'Teamwork: connecting…'
}

async function loadMe($: $): Promise<void> {
  const user = await tw($, 'get_current_user')
  await update($, me, () => user.account?.user?.id ?? user.account?.id ?? user.user?.id ?? null)
  await update($, siteUrl, () => siteOf(user))
  await loadPeople($)
}

// Refreshes, then schedules the next refresh: soon, with a countdown, while the connector is not up yet.
async function poll($: $, options?: { isQuiet?: boolean }): Promise<void> {
  await refresh($, options)
  const isWaiting = isNotConnected(await read($, error))
  const delay = isWaiting ? RETRY_MS : POLL_MS
  if (isWaiting) {
    let left = Math.ceil(delay / 1000)
    await update($, retryIn, () => left)
    const tick = $.clock.every(1000, () => {
      left -= 1
      if (left <= 0) tick.cancel()
      void update($, retryIn, () => Math.max(left, 0))
    })
  }
  $.clock.after(delay, () => void poll($))
}

async function refresh($: $, { isQuiet = false } = {}): Promise<void> {
  try {
    // tried again on every refresh until it works: at startup the connector may not be up yet
    if ((await read($, me)) === null) await loadMe($)
    const myId = await read($, me)
    const before = new Map((await read($, convs)).map(c => [c.id, c.latestId]))
    const fresh: TwConversation[] = []
    for (let page = 0; page < PAGES; page++) {
      const r = await tw($, 'list_conversations', {
        include_message_data: true,
        page_limit: 10,
        page_offset: page * 10,
        sort: 'lastActivityAt',
        status: 'active',
      })
      const batch: Json[] = r.conversations ?? []
      fresh.push(...batch.map(raw => toConversation(raw, myId)))
      if (batch.length < 10) break
    }
    const seenMap = await read($, seen)
    await Promise.all(
      fresh
        .filter(c => isUnread(c, seenMap, myId))
        .map(async c => {
          const viewed = Math.max(c.lastViewedId, seenMap[String(c.id)] ?? 0)
          c.unreadCount = await countUnread($, c, viewed, myId)
        }),
    )
    await update($, convs, () => fresh)
    await update($, error, () => null)
    await update($, retryIn, () => null)

    const arrived = fresh.filter(
      c => before.size > 0 && c.latestId > (before.get(c.id) ?? 0) && isUnread(c, seenMap, myId),
    )
    if (!isQuiet && arrived.length > 0) {
      const c = arrived[0]!
      const more = arrived.length > 1 ? ` (+${arrived.length - 1} more)` : ''
      $.ui.toast(`💬 ${c.title} · ${c.latestAuthor}: ${oneLine(c.latestBody, 80)}${more}`, { timeoutMs: 6000 })
    }
    await setStatus($)

    const v = await read($, view)
    if (v.mode === 'conv' && arrived.some(c => c.id === v.convId) && (await loadMessages($, v.convId))) await touch($)
  } catch (err) {
    await update($, error, () => `Teamwork: ${(err as Error).message}`).catch(() => {})
  }
}

function toFile(raw: Json): TwFile | null {
  if (!raw || typeof raw.id !== 'number') return null
  const thumbs = Object.values(raw.thumbnails ?? {}) as Json[]
  // the smallest thumbnail at least 160 px wide is plenty for a terminal drawing
  const thumb = thumbs.sort((a, b) => a.constraint - b.constraint).find(t => t.constraint >= 160) ?? thumbs.at(-1)
  return {
    id: raw.id,
    name: raw.name ?? 'file',
    url: raw.url ?? '',
    contentType: raw.contentType ?? '',
    bytes: raw.bytes ?? 0,
    width: raw.width ?? 0,
    height: raw.height ?? 0,
    thumbnail: thumb?.url ?? null,
  }
}

// Fetches the conversation's newest messages; true when one arrived since the last fetch.
// Quiet (the open conversation's poll) writes nothing when nothing changed.
async function loadMessages($: $, convId: number, { isQuiet = false } = {}): Promise<boolean> {
  const r = await tw($, 'list_messages', { conversation_id: convId, page_size: 30 })
  const list: TwMessage[] = (r.messages ?? [])
    .map((m: Json) => ({
      id: m.id,
      author: m.author?.fullName ?? '?',
      authorId: m.author?.id ?? 0,
      body: m.body ?? '',
      createdAt: m.createdAt,
      file: toFile(m.file),
    }))
    .reverse()
  // the person may have left (or opened another conversation) while this was fetched
  const v = await read($, view)
  if (v.mode !== 'conv' || v.convId !== convId) return false
  const before = await read($, messages)
  const isSame = before.length === list.length && before.every((m, i) => m.id === list[i]!.id && m.body === list[i]!.body)
  if (isQuiet && isSame) return false
  const hasNew = before.length > 0 && (list.at(-1)?.id ?? 0) > (before.at(-1)?.id ?? 0)
  await update($, messages, () => list)
  void loadPictures($, list).catch(() => {})
  const newest = list.at(-1)?.id ?? 0
  const next = await update($, seen, s => ({ ...s, [String(convId)]: Math.max(s[String(convId)] ?? 0, newest) }))
  await $.store.set('seen', next)
  await setStatus($)
  return hasNew
}

let convTimer: { cancel: () => void } | null = null
let lastActivity = 0

// Something happened in the open conversation (the person did something, a message came), so it stays open.
async function touch($: $): Promise<void> {
  lastActivity = await $.clock.now()
}

async function leaveConv($: $): Promise<void> {
  convTimer?.cancel()
  convTimer = null
  await discardPasted($)
  await update($, suggestion, () => null)
  await update($, hasReplyText, () => false)
  await update($, view, (): TwView => ({ mode: 'all' }))
}

// While a conversation is open: its newest messages every 5 s, and back to the list after 5 idle minutes.
function watchConv($: $, convId: number): void {
  convTimer?.cancel()
  let isFetching = false
  const timer = $.clock.every(CONV_POLL_MS, () => void (async () => {
    const v = await read($, view)
    if (v.mode !== 'conv' || v.convId !== convId) {
      timer.cancel()
      if (convTimer === timer) convTimer = null
      return
    }
    if ((await $.clock.now()) - lastActivity >= CONV_IDLE_MS) {
      await leaveConv($)
      $.ui.toast('Teamwork Chat: back to the list after 5 minutes without activity')
      return
    }
    // one fetch at a time, and none while an action of the person's is running
    if (isFetching || (await read($, isBusy))) return
    isFetching = true
    try {
      if (await loadMessages($, convId, { isQuiet: true })) await touch($)
    } catch {
      // the list's own poll shows a connection error; this one just tries again
    } finally {
      isFetching = false
    }
  })())
  convTimer = timer
}

async function busy($: $, work: () => Promise<void>): Promise<void> {
  await touch($)
  await update($, isBusy, () => true)
  try {
    await work()
    await update($, error, () => null)
  } catch (err) {
    await update($, error, () => (err as Error).message)
  } finally {
    await update($, isBusy, () => false)
  }
}

async function openConv($: $, convId: number, title: string): Promise<void> {
  await update($, view, (): TwView => ({ mode: 'conv', convId, title }))
  await update($, messages, () => [])
  await touch($)
  watchConv($, convId)
  await busy($, async () => {
    await loadMessages($, convId)
  })
}

async function openDm($: $, person: TwPerson): Promise<void> {
  await busy($, async () => {
    const r = await tw($, 'get_or_create_dm', { user_id: person.id })
    const id = r.conversation?.id ?? r.id
    if (typeof id !== 'number') throw new Error('Could not open the direct conversation')
    await openConv($, id, person.name)
  })
}

async function searchPeople($: $, term: string): Promise<TwPerson[]> {
  const myId = await read($, me)
  const r = await tw($, 'list_people', { search_term: term, page_limit: 10 })
  return (r.people ?? [])
    .filter((p: Json) => p.id !== myId && !p.deleted)
    .map((p: Json) => ({ id: p.id, name: `${p.firstName} ${p.lastName}`.trim(), handle: p.handle ?? '' }))
}

// Saves the image on the Windows clipboard as a PNG and prints "path|width|height|bytes".
// The PNG flavour keeps the real pixels; the bitmap flavour often comes with an empty alpha
// channel (an all-black or invisible image), so that one is flattened to 24-bit first.
const CLIPBOARD_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
  '$p = Join-Path $env:TEMP ("tw-paste-" + [guid]::NewGuid().ToString("N") + ".png")',
  '$png = [System.Windows.Forms.Clipboard]::GetData("PNG")',
  // if and else stay on one line: the lines are joined with "; ", which would end the if
  'if ($png -is [System.IO.MemoryStream]) { [System.IO.File]::WriteAllBytes($p, $png.ToArray()) } else { $i = [System.Windows.Forms.Clipboard]::GetImage(); if (-not $i) { exit 3 }; $r = New-Object System.Drawing.Rectangle 0, 0, $i.Width, $i.Height; $i.Clone($r, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb).Save($p, [System.Drawing.Imaging.ImageFormat]::Png) }',
  '$img = [System.Drawing.Image]::FromFile($p); $w = $img.Width; $h = $img.Height; $img.Dispose()',
  '"{0}|{1}|{2}|{3}" -f $p, $w, $h, (Get-Item $p).Length',
].join('; ')

async function grabClipboardImage($: $): Promise<TwPastedImage> {
  if ((await platformOf($)) === 'unix') throw new Error('Pasting an image reads the Windows clipboard: it works in WSL and on Windows.')
  const ran = await $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', CLIPBOARD_SCRIPT], { timeoutMs: 20_000 })
  if (ran.exitCode === 3) throw new Error('There is no image on the clipboard (copy one first, e.g. Win+Shift+S).')
  if (ran.exitCode !== 0) throw new Error(`Could not read the clipboard: ${oneLine(ran.stderr || ran.stdout, 160)}`)
  const [winPath = '', width = '0', height = '0', bytes = '0'] = ran.stdout.trim().split('|')
  if (!winPath || !(Number(width) > 0) || !(Number(bytes) > 0)) {
    throw new Error(`Could not save the clipboard image: ${oneLine(ran.stderr || ran.stdout, 160)}`)
  }
  return { path: await localPath($, winPath), width: Number(width), height: Number(height), bytes: Number(bytes) }
}

async function discardPasted($: $): Promise<void> {
  const image = await read($, pasted)
  await update($, pasted, () => null)
  if (image) await removeFile($, image.path)
}

// The site address, as get_current_user answers it: { account: { url } }.
function siteOf(user: Json): string | null {
  const url = user?.account?.url ?? user?.url
  return typeof url === 'string' && url.startsWith('https://') ? url : null
}

// Teamwork takes an API key as Basic auth (key as the user); a twp_ token may want Bearer instead.
let workingAuth: string | null = null
function authHeaders(key: string): string[] {
  const all = [`Basic ${btoa(`${key}:x`)}`, `Bearer ${key}`]
  return workingAuth ? [workingAuth, ...all.filter(a => a !== workingAuth)] : all
}

// The API hands out its load balancer's host; the same path answers on the Teamwork site.
async function onSite($: $, url: string): Promise<string> {
  const site = await read($, siteUrl)
  if (!site || !url) return url
  try {
    const parsed = new URL(url)
    return site.replace(/\/$/, '') + parsed.pathname + parsed.search
  } catch {
    return url
  }
}

// WSL and native Windows reach PowerShell and the Windows clipboard; Linux and macOS do not.
export function platformFrom(env: Env): Platform {
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return 'wsl'
  if (env.OS === 'Windows_NT') return 'windows'
  return 'unix'
}

// Real pixels need the kitty graphics protocol (kitty, Ghostty); every other terminal gets the mosaic.
export function pictureModeFrom(setting: string | undefined, env: Env): PictureMode {
  if (setting === 'image' || setting === 'mosaic' || setting === 'off') return setting
  const isKittyGraphics = env.TERM === 'xterm-kitty' || !!env.KITTY_WINDOW_ID
    || env.TERM_PROGRAM === 'ghostty' || !!env.GHOSTTY_RESOURCES_DIR
  return isKittyGraphics ? 'image' : 'mosaic'
}

let envCache: Env | null = null
async function envOf($: $): Promise<Env> {
  // each name spelled out: the engine lists the variables a module reads
  envCache ??= {
    WSL_DISTRO_NAME: await $.env.get('WSL_DISTRO_NAME'),
    WSL_INTEROP: await $.env.get('WSL_INTEROP'),
    OS: await $.env.get('OS'),
    TERM: await $.env.get('TERM'),
    KITTY_WINDOW_ID: await $.env.get('KITTY_WINDOW_ID'),
    TERM_PROGRAM: await $.env.get('TERM_PROGRAM'),
    GHOSTTY_RESOURCES_DIR: await $.env.get('GHOSTTY_RESOURCES_DIR'),
    TEMP: (await $.env.get('TEMP')) || undefined,
    TMPDIR: (await $.env.get('TMPDIR')) || undefined,
    HOME: (await $.env.get('HOME')) || undefined,
    USERPROFILE: (await $.env.get('USERPROFILE')) || undefined,
  }
  return envCache
}

async function platformOf($: $): Promise<Platform> {
  return platformFrom(await envOf($))
}

// A file in the temp folder, spelled the way this platform's programs (curl, PowerShell, the terminal) take it.
async function tempFile($: $, name: string): Promise<string> {
  const env = await envOf($)
  if ((await platformOf($)) === 'windows') return `${(env.TEMP ?? `${env.USERPROFILE}\\AppData\\Local\\Temp`).replace(/\\$/, '')}\\${name}`
  return `${(env.TMPDIR ?? '/tmp').replace(/\/$/, '')}/${name}`
}

async function removeFile($: $, path: string): Promise<void> {
  const argv = (await platformOf($)) === 'windows' ? ['cmd.exe', '/d', '/c', 'del', '/q', path] : ['rm', '-f', path]
  await $.process.run(argv).catch(() => undefined)
}

// PowerShell takes Windows paths: WSL translates its own, native Windows already has them.
async function windowsPath($: $, path: string): Promise<string> {
  if ((await platformOf($)) !== 'wsl') return path
  const r = await $.process.run(['wslpath', '-w', path])
  if (r.exitCode !== 0) throw new Error(`Could not translate ${path}: ${oneLine(r.stderr, 160)}`)
  return r.stdout.trim()
}

async function localPath($: $, winPath: string): Promise<string> {
  if ((await platformOf($)) !== 'wsl') return winPath
  const r = await $.process.run(['wslpath', '-u', winPath])
  if (r.exitCode !== 0) throw new Error(`Could not locate ${winPath}: ${oneLine(r.stderr, 160)}`)
  return r.stdout.trim()
}

async function curl($: $): Promise<string> {
  return (await platformOf($)) === 'windows' ? 'curl.exe' : 'curl'
}

function powershell(script: string, ...args: string[]): string[] {
  const quoted = args.map(a => `'${a.replace(/'/g, "''")}'`).join(' ')
  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `& { ${script} } ${quoted}`]
}

const PICTURE_COLUMNS = 48
const PICTURE_MAX_ROWS = 16
const PHOTO_COLUMNS = 60
const PHOTO_MAX_ROWS = 24
const CELL_PIXELS = { width: 10, height: 20 } // roughly a terminal cell; the terminal scales to the box anyway

// Shrinks an image to w x h pixels on white, into $bmp.
const SHRINK_SCRIPT = [
  'Add-Type -AssemblyName System.Drawing',
  '$src = [System.Drawing.Image]::FromFile($path)',
  '$bmp = New-Object System.Drawing.Bitmap ([int]$w), ([int]$h)',
  '$g = [System.Drawing.Graphics]::FromImage($bmp); $g.Clear([System.Drawing.Color]::White)',
  '$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
  // TileFlipXY keeps the resampler from blending the white edge into the picture's first row and column
  '$attr = New-Object System.Drawing.Imaging.ImageAttributes; $attr.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)',
  '$g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, ([int]$w), ([int]$h)), 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel, $attr)',
  '$g.Dispose(); $src.Dispose()',
]

// The shrunk image as one hex string, RRGGBB each: the mosaic's pixels.
const PIXELS_SCRIPT = [
  'param($path, $w, $h)',
  ...SHRINK_SCRIPT,
  '$sb = New-Object System.Text.StringBuilder',
  'for ($y = 0; $y -lt $bmp.Height; $y++) { for ($x = 0; $x -lt $bmp.Width; $x++) { $c = $bmp.GetPixel($x, $y); [void]$sb.Append($c.R.ToString("x2") + $c.G.ToString("x2") + $c.B.ToString("x2")) } }',
  '$sb.ToString()',
].join('\n')

// The shrunk image saved as a PNG (any input, JPEG and GIF too): what the terminal draws as real pixels.
const PNG_SCRIPT = [
  'param($path, $out, $w, $h)',
  ...SHRINK_SCRIPT,
  '$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()',
].join('\n')

export function pictureSize(
  file: Pick<TwFile, 'width' | 'height'>,
  limit = { columns: PICTURE_COLUMNS, rows: PICTURE_MAX_ROWS },
): { columns: number; rows: number } {
  const ratio = file.width > 0 && file.height > 0 ? file.height / file.width : 0.5
  let columns = Math.max(4, Math.min(limit.columns, file.width || limit.columns))
  // a cell is about twice as tall as wide (and the mosaic stacks two pixels in one), so one row per two pixel rows
  if ((columns * ratio) / 2 > limit.rows) columns = Math.max(4, Math.round((limit.rows * 2) / ratio))
  const rows = Math.max(1, Math.min(limit.rows, Math.round((columns * ratio) / 2)))
  return { columns, rows }
}

// Upper-half blocks: the top pixel is the glyph's colour, the bottom one the background.
export function rasterFrom(hex: string, columns: number, rows: number): string {
  const words = new Uint32Array(columns * rows * 3)
  const at = (x: number, y: number) => parseInt(hex.slice((y * columns + x) * 6, (y * columns + x) * 6 + 6), 16) || 0
  for (let row = 0; row < rows; row++) {
    for (let x = 0; x < columns; x++) {
      const i = (row * columns + x) * 3
      words[i] = 0x2580
      words[i + 1] = at(x, row * 2)
      words[i + 2] = at(x, row * 2 + 1)
    }
  }
  const bytes = new Uint8Array(words.buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

// chafa picks, cell by cell, the block shape (halves, quarters, eighths) that best follows the picture.
const CHAFA_ARGS = ['-f', 'symbols', '-c', 'full', '--symbols', 'block+space', '-O', '0', '--relative', 'off',
  '--polite', 'on', '--animate', 'off', '--bg', 'ffffff', '-w', '9']
const DEFAULT_FG = 0x000000
const DEFAULT_BG = 0xffffff

// chafa's truecolor text, one SGR before each cell, into the Raster's cells.
export function cellsFromChafa(text: string): { columns: number; rows: number; cells: string } | null {
  const grid: number[][] = []
  let row: number[] = []
  let fg = DEFAULT_FG
  let bg = DEFAULT_BG
  const pattern = /\x1b\[([0-9;?]*)([A-Za-z])|([^\x1b])/gsu
  for (const m of text.matchAll(pattern)) {
    if (m[2] === 'm') {
      const p = (m[1] || '0').split(';').map(Number)
      for (let i = 0; i < p.length; i++) {
        if (p[i] === 0) [fg, bg] = [DEFAULT_FG, DEFAULT_BG]
        else if ((p[i] === 38 || p[i] === 48) && p[i + 1] === 2) {
          const color = ((p[i + 2]! & 255) << 16) | ((p[i + 3]! & 255) << 8) | (p[i + 4]! & 255)
          if (p[i] === 38) fg = color
          else bg = color
          i += 4
        }
      }
    } else if (m[3] === '\n') {
      grid.push(row)
      row = []
    } else if (m[3] !== undefined && m[3] !== '\r') {
      const code = m[3].codePointAt(0)!
      // a Raster cell holds one width-1 BMP character; anything else draws as its background
      const isCell = code >= 0x20 && code <= 0xffff
      row.push(isCell ? code : 0x20, fg, bg)
    }
  }
  if (row.length > 0) grid.push(row)
  const columns = Math.max(0, ...grid.map(r => r.length / 3))
  if (columns === 0) return null
  const words = new Uint32Array(columns * grid.length * 3)
  grid.forEach((r, y) => {
    for (let x = 0; x < columns; x++) {
      const i = (y * columns + x) * 3
      words.set(x * 3 < r.length ? r.slice(x * 3, x * 3 + 3) : [0x20, DEFAULT_FG, DEFAULT_BG], i)
    }
  })
  const bytes = new Uint8Array(words.buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return { columns, rows: grid.length, cells: btoa(binary) }
}

async function download($: $, file: TwFile, key: string, local: string): Promise<boolean> {
  const source = await onSite($, file.thumbnail ?? file.url)
  const program = await curl($)
  // the key goes to curl on stdin, never in its arguments
  for (const authorization of authHeaders(key)) {
    const got = await $.process.run(
      [program, '-sS', '--fail', '-L', '--max-time', '30', '-K', '-', '-o', local, source],
      { stdin: `header = "Authorization: ${authorization}"\n`, timeoutMs: 40_000 },
    )
    if (got.exitCode === 0) {
      workingAuth = authorization
      return true
    }
  }
  return false
}

async function drawPicture($: $, file: TwFile, key: string, mode: PictureMode): Promise<TwPicture> {
  const platform = await platformOf($)
  if (mode === 'off') return 'failed'
  const local = await tempFile($, `tw-thumb-${file.id}`)
  if (!(await download($, file, key, local))) return 'failed'
  try {
    if (mode === 'image') {
      const { columns, rows } = pictureSize(file, { columns: PHOTO_COLUMNS, rows: PHOTO_MAX_ROWS })
      const out = await tempFile($, `tw-chat-${file.id}.png`)
      const size = [String(columns * CELL_PIXELS.width), String(rows * CELL_PIXELS.height)]
      const made = platform === 'unix'
        ? await $.process.run(['magick', local, '-background', 'white', '-flatten', '-resize', `${size[0]}x${size[1]}`, out])
          .catch(() => undefined)
        : await $.process.run(powershell(PNG_SCRIPT, await windowsPath($, local), await windowsPath($, out), ...size), { timeoutMs: 30_000 })
      if (made?.exitCode === 0) return { columns, rows, file: out }
      // without ImageMagick a PNG still draws as it is; anything else does not
      if (platform !== 'unix' || file.contentType !== 'image/png') return 'failed'
      const moved = await $.process.run(['mv', '-f', local, out])
      return moved.exitCode === 0 ? { columns, rows, file: out } : 'failed'
    }
    const { columns, rows } = pictureSize(file)
    const chafa = await $.process.run(['chafa', ...CHAFA_ARGS, '-s', `${columns}x${rows}`, local], { timeoutMs: 30_000 })
      .catch(() => undefined)
    const sharp = chafa?.exitCode === 0 ? cellsFromChafa(chafa.stdout) : null
    if (sharp) return sharp
    // without chafa: half blocks from PowerShell's pixels, which Linux and macOS lack
    if (platform === 'unix') return 'failed'
    const pixels = await $.process.run(
      powershell(PIXELS_SCRIPT, await windowsPath($, local), String(columns), String(rows * 2)),
      { timeoutMs: 30_000 },
    )
    const hex = pixels.stdout.trim()
    if (pixels.exitCode !== 0 || hex.length < columns * rows * 2 * 6) return 'failed'
    return { columns, rows, cells: rasterFrom(hex, columns, rows) }
  } finally {
    await removeFile($, local)
  }
}

async function loadPictures($: $, list: TwMessage[]): Promise<void> {
  const mode = pictureModeFrom(pictureSetting, await envOf($))
  if (mode === 'off') return
  const key = await apiKey($)
  if (!key) return
  const have = await read($, pictures)
  const wanted = list
    .map(m => m.file)
    .filter((f): f is TwFile => f !== null && f.contentType.startsWith('image/') && !(String(f.id) in have))
  for (const file of wanted) {
    await update($, pictures, all => ({ ...all, [String(file.id)]: 'loading' as TwPicture }))
    const picture = await drawPicture($, file, key, mode).catch((): TwPicture => 'failed')
    await update($, pictures, all => ({ ...all, [String(file.id)]: picture }))
  }
}

const UPLOAD_URL = 'https://chat-uploads.teamwork.com/uploads'

// The key lives in teamwork.env inside the Claude config folder (~/.claude-work for claude-work).
async function keyFile($: $): Promise<string> {
  const env = await envOf($)
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${env.HOME ?? env.USERPROFILE ?? ''}/.claude`
  return `${dir.replace(/\/$/, '')}/teamwork.env`
}

async function apiKey($: $): Promise<string | undefined> {
  const fromEnv = (await $.env.get('TEAMWORK_API_KEY'))?.trim()
  if (fromEnv) return fromEnv
  try {
    const text = await $.fs.read(await keyFile($))
    const line = text.split('\n').map(l => l.trim()).find(l => l.startsWith('TEAMWORK_API_KEY='))
    const value = line?.slice('TEAMWORK_API_KEY='.length).trim().replace(/^['"]|['"]$/g, '')
    return value || undefined
  } catch {
    return undefined
  }
}

// The web app's own two steps: upload the file (no login), then post a message carrying its tempId.
async function sendImage($: $, convId: number, image: TwPastedImage, onStep: (step: string) => Promise<void>, caption = ''): Promise<void> {
  const key = await apiKey($)
  if (!key) {
    throw new Error(`Put your Teamwork API key in ${await keyFile($)} as TEAMWORK_API_KEY=… (or set it in the environment).`)
  }

  await onStep('Uploading the image')
  const up = await $.process.run(
    [await curl($), '-sS', '--fail-with-body', '--max-time', '60', '-F', `file=@${image.path};type=image/png`, UPLOAD_URL],
    { timeoutMs: 70_000 },
  )
  if (up.exitCode !== 0) throw new Error(`Image upload failed: ${oneLine(up.stdout || up.stderr, 160)}`)
  let tempId: unknown
  try {
    tempId = JSON.parse(up.stdout).tempId
  } catch {
    tempId = undefined
  }
  if (typeof tempId !== 'string') throw new Error(`Image upload gave no tempId: ${oneLine(up.stdout, 160)}`)

  let site = await read($, siteUrl)
  if (!site) {
    site = siteOf(await tw($, 'get_current_user'))
    await update($, siteUrl, () => site)
  }
  if (!site) throw new Error('Could not find your Teamwork site address (get_current_user gave no account.url).')
  const url = `${site.replace(/\/$/, '')}/chat/v7/conversations/${convId}/messages`
  const body = JSON.stringify({ message: { body: caption, file: { tempId } } })
  await onStep('Posting it to the conversation')
  for (const authorization of authHeaders(key)) {
    const sent = await $.http.fetch(url, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json', accept: 'application/json' },
      body,
    })
    if (sent.ok) {
      workingAuth = authorization
      return
    }
    if (sent.status !== 401 && sent.status !== 403) {
      throw new Error(`Teamwork refused the image message (${sent.status}): ${oneLine(sent.text, 160)}`)
    }
  }
  throw new Error('Teamwork did not accept TEAMWORK_API_KEY (401/403). Check the key.')
}

// Opens a web address in the Windows default browser (WSL, Windows), else the Linux or macOS one.
async function openInBrowser($: $, url: string): Promise<void> {
  if (!/^https:\/\//.test(url)) throw new Error('Only https links are opened.')
  if ((await platformOf($)) !== 'unix') {
    // explorer.exe hands the URL to the default browser; it reports exit code 1 even when it worked
    const viaWindows = await $.process.run(['explorer.exe', url]).catch(() => undefined)
    if (viaWindows) return
  }
  for (const opener of ['xdg-open', 'open']) {
    const ran = await $.process.run([opener, url]).catch(() => undefined)
    if (ran?.exitCode === 0) return
  }
  throw new Error(`Could not open a browser. The link: ${url}`)
}

const SEND_FRAME_MS = 120
const SEND_BAR = { width: 24, lit: 6 }

// The lit run of the sending bar for one frame: it sweeps right, then back, never off the track.
export function sweep(frame: number, width = SEND_BAR.width, lit = SEND_BAR.lit): { before: number; lit: number; after: number } {
  const span = width - lit
  const at = span <= 0 ? 0 : frame % (span * 2) <= span ? frame % (span * 2) : span * 2 - (frame % (span * 2))
  return { before: at, lit: Math.min(lit, width), after: Math.max(0, width - lit - at) }
}

// Sends the pasted image with a moving bar, the step it is on and the seconds so far, in place of its buttons.
async function sendPasted($: $, convId: number, image: TwPastedImage): Promise<void> {
  const startedAt = await $.clock.now()
  let frame = 0
  await update($, sending, () => ({ step: 'Uploading the image', frame, seconds: 0 }))
  const timer = $.clock.every(SEND_FRAME_MS, () => void (async () => {
    frame += 1
    const seconds = Math.floor(((await $.clock.now()) - startedAt) / 1000)
    await update($, sending, s => (s ? { ...s, frame, seconds } : s))
  })())
  const onStep = async (step: string) => {
    await update($, sending, s => (s ? { ...s, step } : s))
  }
  try {
    await busy($, async () => {
      await sendImage($, convId, image, onStep)
      await onStep('Loading the conversation')
      await discardPasted($)
      await loadMessages($, convId)
    })
  } finally {
    timer.cancel()
    await update($, sending, () => null)
  }
}

function sizeLabel(bytes: number): string {
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

// Drafts a reply from the last messages of the open conversation and puts it into the field.
async function suggestReply($: $, convId: number, title: string): Promise<void> {
  const myId = await read($, me)
  const myName = (myId !== null && names.get(myId)) || 'me'
  const recent = (await read($, messages)).slice(-20)
  if (recent.length === 0) throw new Error('There are no messages to reply to yet.')
  const transcript = recent
    .map(m => `${m.authorId === myId ? `${myName} (me)` : m.author}: ${m.body || (m.file ? `[file: ${m.file.name}]` : '')}`)
    .join('\n')
  await update($, isSuggesting, () => true)
  try {
    const r = await $.model.complete({
      model: 'sonnet',
      maxTokens: 400,
      system:
        `You draft the next chat message for ${myName} in a Teamwork Chat conversation ("${title}"). ` +
        'Write in the language and tone the conversation uses, briefly, as a colleague would. ' +
        'Answer with the message text only: no quotes, no name, no explanation.',
      prompt: `The conversation so far, oldest first:\n\n${transcript}\n\nWrite ${myName}'s next message.`,
    })
    if (!r.isAnswered) throw new Error(`Could not draft a reply (${r.reason}).`)
    const text = r.text.trim().replace(/^["„“]|["“”]$/g, '')
    await update($, suggestion, () => ({ convId, text }))
  } finally {
    await update($, isSuggesting, () => false)
  }
}

async function openFromBadge($: $, c: TwConversation): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Teamwork Chat', focus: true })
  await openConv($, c.id, c.title)
}

async function showPane($: $, mode: TwView): Promise<void> {
  await update($, view, () => mode)
  await $.ui.open({ id: PANE, title: 'Teamwork Chat', focus: true })
}

let pictureSetting: string | undefined

export const register: Register = (on, options) => {
  pictureSetting = typeof options?.pictures === 'string' ? options.pictures : undefined
  let isDocked = false
  // A session started with TEAMWORK_CHAT_DOCK=1 (the claude-status launcher) docks the chat as its main view.
  let isLauncher = false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tw', description: 'Teamwork Chat: open conversations (/tw unread for unread only)' })
    await $.command.register({
      name: 'tw-dm',
      description: 'Teamwork Chat: send a direct message',
      argumentHint: '<name surname | @handle> <message>',
    })
    await $.command.register({ name: 'tw-focus', description: 'Teamwork Chat: hide or show the Claude conversation' })

    isLauncher = (await $.env.get('TEAMWORK_CHAT_DOCK')) === '1'

    void (async () => {
      const stored = (await $.store.get('seen')) as Record<string, number> | undefined
      if (stored) await update($, seen, () => stored)
      const focus = await $.store.get('isFocus')
      // the launcher keeps the Claude column visible (it shows the routines); elsewhere the stored choice
      if (isLauncher) await update($, isFocus, () => false)
      else if (typeof focus === 'boolean') await update($, isFocus, () => focus)
      await poll($, { isQuiet: true })
    })().catch(() => {})

    return next(e)
  })

  on('command.run', { command: 'tw' }, async ($, e) => {
    await refresh($, { isQuiet: true })
    await showPane($, e.args.trim() === 'unread' ? { mode: 'unread' } : { mode: 'all' })
    return { text: 'Teamwork Chat opened.' }
  })

  on('command.run', { command: 'tw-focus' }, async $ => {
    const now = await update($, isFocus, value => !value)
    await $.store.set('isFocus', now)
    return { text: now ? 'Claude conversation hidden.' : 'Claude conversation shown.' }
  })

  on('ui.render', { component: HIDDEN_ROWS }, async ($, e, next) => {
    // ctrl+o (expanded transcript) still shows everything
    const isExpanded = (e.props as { isExpanded?: boolean }).isExpanded === true
    if (isExpanded || !(await read($, isFocus))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  on('command.run', { command: 'tw-dm' }, async ($, e) => {
    const usage = { text: 'Usage: /tw-dm <name surname | @handle> <message>' }
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    if (words.length < 2) return usage

    let person: TwPerson | undefined
    let body = ''
    if (words[0]!.startsWith('@')) {
      const handle = words[0]!.slice(1)
      const found = await searchPeople($, handle)
      person = found.find(p => fold(p.handle) === fold(handle)) ?? (found.length === 1 ? found[0] : undefined)
      body = words.slice(1).join(' ')
      if (!person) return { text: `Nobody in Teamwork Chat has the handle @${handle}.` }
    } else {
      // The name is the longest run of leading words that a person's full name starts with.
      const found = await searchPeople($, words[0]!)
      let best: { people: TwPerson[]; count: number } = { people: [], count: 0 }
      // Up to every word, so a bare "Name Surname" is caught as having no message.
      for (let count = Math.min(words.length, 4); count >= 1; count--) {
        const typed = fold(words.slice(0, count).join(' '))
        const hits = found.filter(p => {
          const name = fold(p.name)
          return name === typed || name.startsWith(typed + ' ')
        })
        if (hits.length > 0) {
          best = { people: hits, count }
          break
        }
      }
      if (best.people.length === 0) return { text: `Nobody in Teamwork Chat matches "${words[0]}".` }
      if (best.people.length > 1) {
        return {
          text: `"${words.slice(0, best.count).join(' ')}" matches several people, add the surname or use @handle: ${best.people.map(p => `${p.name} (@${p.handle})`).join(', ')}`,
        }
      }
      person = best.people[0]!
      body = words.slice(best.count).join(' ')
    }
    if (!body) return usage
    await tw($, 'send_dm', { user_id: person.id, body })
    void refresh($, { isQuiet: true })
    return { text: `Sent to ${person.name}.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const list = await read($, convs)
    const seenMap = await read($, seen)
    const myId = await read($, me)
    const err = errorLine(await read($, error), await read($, retryIn))
    const focus = await read($, isFocus)
    const unread = list.filter(c => isUnread(c, seenMap, myId))

    // A launcher session in the fullscreen layout seats the pane once, wide, beside the transcript.
    const viewport = e.viewport
    if (isLauncher && viewport?.isFullscreen === true && !isDocked) {
      isDocked = true
      const columns = Math.max(60, viewport.columns - CLAUDE_COLUMNS)
      $.clock.after(0, () => void $.ui.open({ id: PANE, title: 'Teamwork Chat', columns }))
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const width = e.props.bodyColumns
    const isNarrow = width < 45
    const toggle = (
      <Button key="tw-focus" label={focus ? 'Show Claude' : 'Hide Claude'} hotkey="c" dimColor
        onPress={() => void (async () => {
          const now = await update($, isFocus, value => !value)
          await $.store.set('isFocus', now)
        })()} />
    )
    const open = (
      <Button key="tw-open" label="Open" hotkey="t"
        onPress={() => void showPane($, unread.length > 0 ? { mode: 'unread' } : { mode: 'all' })} />
    )

    if (isNarrow) {
      return (
        <Box>
          <Text color={unread.length > 0 ? 'warning' : undefined} bold>
            💬 {err ? '!' : unread.length === 0 ? '0' : countLabel(unread.reduce((sum, c) => sum + c.unreadCount, 0))}{' '}
          </Text>
          {open}
          {toggle}
        </Box>
      )
    }

    let state
    if (err) state = <Text color="error" wrap="truncate">{oneLine(err, Math.max(10, width - 45))} </Text>
    else if (list.length === 0) state = <Text dimColor>connecting… </Text>
    else if (unread.length === 0) state = <Text color="success">no unread </Text>
    else {
      // one line of badges, as many as fit, then "+N"
      let room = Math.max(12, width - 45)
      const fits: TwConversation[] = []
      for (const c of unread) {
        const cost = Math.min(c.title.length, 18) + countLabel(c.unreadCount).length + 4
        if (cost > room && fits.length > 0) break
        fits.push(c)
        room -= cost
      }
      const rest = unread.length - fits.length
      state = (
        <Box flexDirection="row" gap={1}>
          {fits.map(c => (
            <Box key={`band-${c.id}`} flexDirection="row">
              <Button key={`bb-${c.id}`} plain label={oneLine(c.title, 18)} onPress={() => void openFromBadge($, c)} />
              <Text backgroundColor="warning" color="inverseText" bold> {countLabel(c.unreadCount)} </Text>
            </Box>
          ))}
          {rest > 0 && <Text dimColor>+{rest}</Text>}
          <Text> </Text>
        </Box>
      )
    }
    return (
      <Box>
        <Text bold>💬 Teamwork · </Text>
        {state}
        {open}
        {toggle}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>Teamwork Chat needs a terminal or desktop surface.</Text>
    }
    const table = $.ui.resolve(e)
    const { Box, Button, Input, Link, Text } = table
    // only the terminal draws cell grids; elsewhere the file link stands alone
    const Raster = 'Raster' in table ? table.Raster : undefined
    const Image = 'Image' in table ? table.Image : undefined
    const width = e.props.bodyColumns
    const v = await read($, view)
    const list = await read($, convs)
    const seenMap = await read($, seen)
    const myId = await read($, me)
    const err = errorLine(await read($, error), await read($, retryIn))
    const loading = await read($, isBusy)
    const unreadCount = list.filter(c => isUnread(c, seenMap, myId)).length

    // Tabs and actions as framed badges of three Buttons (top edge, label, bottom edge) sharing one
    // action, so the whole badge is clickable; hovering it inverts all three rows as one block. The
    // active tab gets a heavy frame and full-strength text; the rest a thin, dim one.
    const chip = (key: string, label: string, onPress: () => void, isActive = false, hotkey?: string) => {
      const inner = ` ${label} `
      if (isActive) {
        // The active tab is no Button (pressing it would do nothing), so it can take colours:
        // a gold rounded badge that turns orange under the pointer, with no inversion.
        return (
          <Box key={`chip-${key}`} borderStyle="round" borderColor={GOLD} hover={{ scope: 'active-tab', borderColor: ORANGE }}>
            <Text color={GOLD} bold hover={{ scope: 'active-tab', color: ORANGE }}>{inner}</Text>
          </Box>
        )
      }
      const edge = '─'.repeat(columnsOf(inner))
      // The surface inverts the Button row under the pointer and no Button can opt out, so every
      // row inverts in orange on hover: the whole badge becomes one solid orange block.
      const invert = { color: ORANGE, inverse: true, dimColor: false } as const
      // a hotkey draws as "v: " before the middle row, so the top and bottom rows step in as far
      const indent = hotkey ? <Text>{' '.repeat(columnsOf(`${hotkey}: `))}</Text> : null
      return (
        <Box key={`chip-${key}`} flexDirection="column">
          <Box flexDirection="row">{indent}<Button key={`${key}-top`} plain dimColor hover={invert} label={`╭${edge}╮`} onPress={onPress} /></Box>
          <Button key={key} plain dimColor hover={invert} hotkey={hotkey} label={`│${inner}│`} onPress={onPress} />
          <Box flexDirection="row">{indent}<Button key={`${key}-bottom`} plain dimColor hover={invert} label={`╰${edge}╯`} onPress={onPress} /></Box>
        </Box>
      )
    }
    const tabs = (
      <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <Box flexDirection="row" gap={1}>
          {chip('tab-all', 'All', () => void update($, view, (): TwView => ({ mode: 'all' })), v.mode === 'all')}
          {chip('tab-unread', unreadCount > 0 ? `Unread · ${unreadCount}` : 'Unread',
            () => void update($, view, (): TwView => ({ mode: 'unread' })), v.mode === 'unread')}
          {chip('tab-people', '✎ New message', () => void update($, view, (): TwView => ({ mode: 'people' })), v.mode === 'people')}
        </Box>
        {/* the pane's own close mark sits on its frame, so no close badge here */}
        {chip('refresh', '⟳ Refresh', () => void refresh($, { isQuiet: true }))}
      </Box>
    )

    let body
    if (v.mode === 'all' || v.mode === 'unread') {
      const shown = v.mode === 'unread' ? list.filter(c => isUnread(c, seenMap, myId)) : list
      body = (
        <Box flexDirection="column">
          {shown.length === 0 && <Text dimColor>{v.mode === 'unread' ? 'No unread conversations.' : 'Loading…'}</Text>}
          {shown.map(c => {
            const isNew = isUnread(c, seenMap, myId)
            const last = c.latestAuthorId === myId ? 'You' : (c.latestAuthor.split(' ')[0] ?? '')
            const time = when(c.latestAt)
            const pill = isNew ? ` ${countLabel(c.unreadCount)} ` : ''
            // Both lines are full-width Buttons, so a click anywhere on the card opens it.
            const lineWidth = Math.max(20, width - 3 - (isNew ? pill.length + 1 : 0))
            const icon = `${iconOf(c)} `
            const titleRoom = Math.max(8, lineWidth - icon.length - time.length - 2)
            const head = icon + oneLine(c.title, titleRoom)
            const firstLine = head + ' '.repeat(Math.max(1, lineWidth - head.length - time.length)) + time
            const preview = oneLine(`   ${last}: ${c.latestBody || '…'}`, Math.max(20, width - 3))
            const open = () => void openConv($, c.id, c.title)
            // the surface inverts the line under the pointer; inverting both lines keeps the card one block
            const rowHover = { inverse: true, dimColor: false } as const
            return (
              <Box key={`row-${c.id}`} flexDirection="row" marginBottom={1}>
                <Text color={isNew ? 'warning' : 'subtle'}>{isNew ? '▌' : '│'} </Text>
                <Box flexDirection="column" flexGrow={1}>
                  <Box flexDirection="row">
                    <Button key={`c-${c.id}`} plain dimColor={!isNew} hover={rowHover} label={firstLine} onPress={open} />
                    {isNew && <Text> </Text>}
                    {isNew && <Text backgroundColor="warning" color="inverseText" bold>{pill}</Text>}
                  </Box>
                  <Button key={`cp-${c.id}`} plain dimColor hover={rowHover}
                    label={preview + ' '.repeat(Math.max(0, width - 3 - preview.length))} onPress={open} />
                </Box>
              </Box>
            )
          })}
        </Box>
      )
    } else if (v.mode === 'conv') {
      const msgs = await read($, messages)
      // Show the newest messages that fit, so the header and the reply row stay on screen.
      const back = () => void leaveConv($)
      const image = await read($, pasted)
      const sendState = await read($, sending)
      const drafting = await read($, isSuggesting)
      const suggested = await read($, suggestion)
      const draftText = suggested?.convId === v.convId ? suggested.text : undefined
      // A field keeps what was typed over any value drawn into it, so clearing draws a fresh field.
      const generation = await read($, replyGeneration)
      const replyKey = generation === 0 ? 'reply' : `reply-${generation}`
      // ✕ shows only while the field holds something; written when that flips, not per keystroke
      const isTyped = await read($, hasReplyText)
      const showClear = isTyped || (draftText ?? '') !== ''
      const clearReply = () => void (async () => {
        await touch($)
        await update($, suggestion, () => null)
        await update($, hasReplyText, () => false)
        const next = await update($, replyGeneration, n => n + 1)
        await $.ui.focus({ requestId: PANE, key: `reply-${next}` }).catch(() => undefined)
      })()
      const drawn = await read($, pictures)
      const site = await read($, siteUrl)
      const linkOf = (f: TwFile) => {
        if (!site || !f.url) return f.url
        try {
          const parsed = new URL(f.url)
          return site.replace(/\/$/, '') + parsed.pathname
        } catch {
          return f.url
        }
      }
      const conv = list.find(c => c.id === v.convId)
      let room = Math.max(6, (e.props.scroll?.bodyRows ?? 30) - 14)
      let from = msgs.length
      while (from > 0) {
        const m = msgs[from - 1]!
        const textRows = m.body.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / Math.max(20, width - 5))), 0)
        const fileRows = m.file ? 2 + (m.file.contentType.startsWith('image/') ? pictureSize(m.file).rows : 0) : 0
        const rows = 2 + textRows + fileRows
        if (rows > room && from < msgs.length) break
        room -= rows
        from--
      }
      const visible = msgs.slice(from)
      body = (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1} marginBottom={1} alignItems="center">
            {chip('back', '← Back', back)}
            <Box flexDirection="row" flexGrow={1}>
              <Text color="warning">{'▌\n▌'}</Text>
              <Box flexDirection="column" marginLeft={1}>
                <Text bold>{conv ? iconOf(conv) : '💬'} {oneLine(v.title, Math.max(8, width - 40))}</Text>
                <Text dimColor>{conv ? kindOf(conv) : 'Conversation'}</Text>
              </Box>
            </Box>
            {chip('suggest', drafting ? '✨ Writing…' : '✨ Suggest reply', () => {
              if (!drafting) void busy($, () => suggestReply($, v.convId, v.title))
            })}
          </Box>
          {msgs.length === 0 && <Text dimColor>{loading ? 'Loading…' : 'No messages.'}</Text>}
          {from > 0 && <Text dimColor>↑ {from} older {from === 1 ? 'message' : 'messages'}</Text>}
          {visible.map(m => {
            const isMine = m.authorId === myId
            return (
            // the list's card: a bar, the author with the time on the right, the content indented below
            <Box flexDirection="row" marginTop={1}>
              <Text color={isMine ? 'suggestion' : 'subtle'}>{isMine ? '▌' : '│'} </Text>
              <Box flexDirection="column" flexGrow={1}>
                <Box flexDirection="row" justifyContent="space-between">
                  <Text bold color={isMine ? 'suggestion' : undefined}>{isMine ? 'You' : m.author}</Text>
                  <Text dimColor>{clock(m.createdAt)}</Text>
                </Box>
                <Box flexDirection="column" paddingLeft={3}>
              {m.body !== '' && <Text wrap="wrap">{splitLinks(m.body).map(part => (typeof part === 'string' ? part : <Link href={part.href} />))}</Text>}
              {m.file && (() => {
                const f = m.file
                const picture = drawn[String(f.id)]
                const href = linkOf(f)
                return (
                  <Box flexDirection="column">
                    {Image && typeof picture === 'object' && 'file' in picture && (() => {
                      // a narrow pane shrinks the box, both ways, so the picture keeps its shape
                      const columns = Math.min(picture.columns, Math.max(4, width - 6))
                      const rows = Math.max(1, Math.round((picture.rows * columns) / picture.columns))
                      return <Image key={`pic-${f.id}`} source={{ file: picture.file, format: 'png' }} columns={columns} rows={rows} alt={`🖼  ${f.name}`} />
                    })()}
                    {Raster && typeof picture === 'object' && 'cells' in picture && <Raster key={`pic-${f.id}`} columns={picture.columns} rows={picture.rows} cells={picture.cells} />}
                    {picture === 'loading' && <Text dimColor>🖼  loading image…</Text>}
                    <Box key={`file-${f.id}`} flexDirection="row" alignSelf="flex-start" borderStyle="round"
                      borderColor="suggestion" paddingX={1} hover={{ borderColor: 'claude' }}>
                      <Button key={`open-${f.id}`} plain
                        label={`${f.contentType.startsWith('image/') ? '🖼 ' : '📎'} ${oneLine(f.name, Math.max(10, width - 30))} · ${sizeLabel(f.bytes)}${href ? ' ↗' : ''}`}
                        onPress={() => {
                          if (href) void busy($, () => openInBrowser($, href))
                        }} />
                    </Box>
                    {href && <Link href={href} label={href} />}
                  </Box>
                )
              })()}
                </Box>
              </Box>
            </Box>
            )
          })}
          {image && (
            <Box key="pasted" marginTop={1} flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1}>
              <Text>🖼  {image.width}×{image.height} · {sizeLabel(image.bytes)}</Text>
              {sendState ? (() => {
                // no percentage: the whole image leaves at once, the wait is Teamwork's, so the bar only shows it is moving
                const run = sweep(sendState.frame)
                return (
                  <Box key="image-sending" flexDirection="row" marginY={1}>
                    <Text dimColor>{'─'.repeat(run.before)}</Text>
                    <Text color="suggestion">{'━'.repeat(run.lit)}</Text>
                    <Text dimColor>{'─'.repeat(run.after)}</Text>
                    <Text dimColor> {sendState.step}… {sendState.seconds}s</Text>
                  </Box>
                )
              })() : (
                <Box flexDirection="row" gap={1}>
                  {chip('image-send', 'Send', () => void sendPasted($, v.convId, image))}
                  {chip('image-cancel', 'Cancel', () => void touch($).then(() => discardPasted($)))}
                </Box>
              )}
            </Box>
          )}
          {!sendState && (
            <Box marginTop={1}>
              {chip('paste', '📋 Paste image', () => void busy($, async () => {
                await discardPasted($)
                const grabbed = await grabClipboardImage($)
                await update($, pasted, () => grabbed)
              }), false, 'v')}
            </Box>
          )}
          <Box marginTop={1} flexDirection="row" gap={1}>
            <Box flexGrow={1}>
            <Input key={replyKey} placeholder="Write a message…" submitLabel="send" autoFocus value={draftText}
              onInput={(text: string) => {
                void touch($)
                if ((text !== '') !== isTyped) void update($, hasReplyText, () => text !== '')
              }}
              onSubmit={(text: string) => {
                void update($, suggestion, () => null)
                void update($, hasReplyText, () => false)
                if (!text.trim()) return
                void busy($, async () => {
                  await tw($, 'send_message', { conversation_id: v.convId, body: text })
                  await loadMessages($, v.convId)
                  await refresh($, { isQuiet: true })
                })
              }} />
            </Box>
            {showClear && <Button key="clear" plain label="✕" onPress={clearReply} />}
          </Box>
        </Box>
      )
    } else {
      const found = await read($, people)
      body = (
        <Box flexDirection="column">
          <Input key="search" label="To: " placeholder="name or email, Enter to search" submitLabel="search" autoFocus
            onSubmit={(term: string) => void busy($, async () => {
              const result = await searchPeople($, term)
              await update($, people, () => result)
            })} />
          {found.map(p => (
            <Button key={`p-${p.id}`} plain label={oneLine(`${p.name}  @${p.handle}`, width - 2)}
              onPress={() => void openDm($, p)} />
          ))}
        </Box>
      )
    }

    const unreadNow = list.filter(c => isUnread(c, seenMap, myId))
    // Unread cards: one size, so they line up in a grid; both lines open the conversation.
    const totalUnread = unreadNow.reduce((sum, c) => sum + c.unreadCount, 0)
    const inner = Math.max(16, Math.min(26, width - 4))
    const badges = unreadNow.length === 0 ? (
      list.length > 0 && (
        <Box flexDirection="row" marginBottom={1}>
          <Text color="success" bold>✓ All caught up</Text>
          <Text dimColor> · no unread messages</Text>
        </Box>
      )
    ) : (
      <Box flexDirection="column" marginBottom={1}>
        <Box flexDirection="row">
          <Text color="warning" bold>🔔 Unread</Text>
          <Text dimColor>
            {' '}· {totalUnread} {totalUnread === 1 ? 'message' : 'messages'} in {unreadNow.length}{' '}
            {unreadNow.length === 1 ? 'conversation' : 'conversations'}
          </Text>
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {unreadNow.map(c => {
            const pill = ` ${countLabel(c.unreadCount)} `
            const head = `${iconOf(c)} ${oneLine(c.title, inner - pill.length - 4)}`
            const who = c.latestAuthorId === myId ? 'You' : (c.latestAuthor.split(' ')[0] ?? '')
            const preview = oneLine(`${who}: ${c.latestBody || '…'}`, inner)
            const open = () => void openConv($, c.id, c.title)
            return (
              <Box key={`badge-${c.id}`} flexDirection="column" borderStyle="round" borderColor="warning"
                paddingX={1} hover={{ borderColor: 'claude' }}>
                <Box flexDirection="row">
                  <Button key={`pb-${c.id}`} plain hover={{ color: 'claude' }}
                    label={head + ' '.repeat(Math.max(1, inner - pill.length - head.length))} onPress={open} />
                  <Text backgroundColor="warning" color="inverseText" bold hover={{ backgroundColor: 'claude' }}>{pill}</Text>
                </Box>
                <Button key={`pp-${c.id}`} plain dimColor hover={{ color: 'claude', dimColor: false }}
                  label={preview + ' '.repeat(Math.max(0, inner - preview.length))} onPress={open} />
              </Box>
            )
          })}
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {badges}
        {tabs}
        {err && <Text color="error">{err}</Text>}
        {loading && v.mode !== 'conv' && <Text dimColor>Working…</Text>}
        {body}
      </Box>
    )
  })
}
