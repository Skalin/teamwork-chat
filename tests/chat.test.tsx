import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { columnsOf, pictureSize, rasterFrom } from '../hooks/register.tsx'

const ME = 1
const ANNA = 2
const FILIP = 3
const MARCELA = 4

const conversations = [
  {
    id: 10, title: null, type: 'pair', lastViewedMessageId: 100,
    people: [{ id: ME }, { id: ANNA }],
    latestMessage: { id: 101, body: 'Ahoj, máš chvilku?', createdAt: '2026-10-06T08:00:00.000Z', author: { id: ANNA, fullName: 'Anna Nová' } },
  },
  {
    id: 20, title: 'Dev', type: 'public', lastViewedMessageId: 200,
    people: [{ id: ME }, { id: ANNA }],
    latestMessage: { id: 200, body: 'old news', createdAt: '2026-10-06T07:00:00.000Z', author: { id: ANNA, fullName: 'Anna Nová' } },
  },
]

const everyone = [
  { id: ANNA, firstName: 'Anna', lastName: 'Nová', handle: 'anna' },
  { id: FILIP, firstName: 'Filip', lastName: 'Čižmár', handle: 'filip' },
  { id: MARCELA, firstName: 'Marcela', lastName: 'Filipová', handle: 'marcela' },
]

const reply = (data: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(data) }], isError: false } })

function engine(on: On) {
  const sent: { tool: string; args: unknown }[] = []
  mock.store(on)
  mock.clock(on)
  on('session.start', () => ({ cwd: '/' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.render', () => h('Text', {}, 'engine'))
  on('ui.toast', () => ({ value: undefined }))
  on('mcp.call', ($, e) => {
    switch (e.tool) {
      case 'twchat-get_current_user':
        // the real shape: { account: { id, url, user: { id } } }
        return reply({ account: { id: ME, url: 'https://xproduction.teamwork.com/', user: { id: ME } } })
      case 'twchat-list_people': {
        // Teamwork matches the search term anywhere in the name, like "Filip" in "Filipová"
        const term = String(e.args.search_term ?? '').toLowerCase()
        const people = everyone.filter(p => `${p.firstName} ${p.lastName} ${p.handle}`.toLowerCase().includes(term))
        return reply({ people, meta: { page: { total: people.length } } })
      }
      case 'twchat-list_conversations': return reply({ conversations: (e.args.page_offset ?? 0) === 0 ? conversations : [] })
      case 'twchat-list_messages': {
        const latest = conversations[0]!.latestMessage
        // two unread messages from Anna after the last viewed one
        if (e.args.after_message_id === 100) return reply({ messages: [latest, { ...latest, id: 100.5 }] })
        return reply({ messages: [latest] })
      }
      case 'twchat-send_message':
      case 'twchat-send_dm':
        sent.push({ tool: e.tool, args: e.args })
        return reply({})
      default: return reply({})
    }
  })
  return sent
}

const BAND = {
  plugin: 'teamwork-chat', surface: 'terminal', component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as any,
} as const

test('band counts unread, opening the conversation reads it, replies are sent', async ($, on) => {
  const sent = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'tw', args: '' })

  const band = await $.ui.mount(BAND)
  expect(await band.find({ key: 'bb-10' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: / 2 / })).toBeDefined()

  const pane = await $.ui.mount({
    plugin: 'teamwork-chat', surface: 'terminal', component: 'Pane', requestId: 'teamwork-chat',
    props: { title: 'Teamwork Chat', isFocused: true, bodyColumns: 80, placement: 'dock' } as any,
  })
  expect(await pane.find({ key: 'c-20' })).toBeDefined()
  // the active tab is a gold badge (text, not a button); the others are clickable on every row
  expect(await pane.find({ type: 'Button', key: 'tab-all' })).toBeUndefined()
  expect((await pane.find({ type: 'Text', text: ' All ' }))?.props).toMatchObject({ color: '#d4a017', bold: true })
  expect((await pane.find({ key: 'tab-unread-top' }))?.text).toBe('╭────────────╮')
  await pane.press({ key: 'tab-unread-bottom' })
  expect((await pane.find({ type: 'Text', text: ' Unread · 1 ' }))?.props).toMatchObject({ color: '#d4a017' })
  expect(await pane.find({ type: 'Button', key: 'tab-unread' })).toBeUndefined()
  await pane.press({ key: 'tab-all-top' })
  const hoverOf = (node: any, key: string): unknown => {
    if (node?.props?.key === key) return node.hover
    for (const child of node?.children ?? []) {
      const found = hoverOf(child, key)
      if (found !== undefined) return found
    }
    return undefined
  }
  const tree = await pane.drawn()
  // both lines of a conversation card invert together
  for (const line of ['c-10', 'cp-10']) {
    expect(hoverOf(tree, line)).toEqual({ inverse: true, dimColor: false })
  }
  for (const row of ['tab-unread-top', 'tab-unread', 'tab-unread-bottom']) {
    expect(hoverOf(tree, row)).toEqual({ color: '#ff8c00', inverse: true, dimColor: false })
  }
  expect(await pane.find({ key: 'pb-10' })).toBeDefined()
  expect(await pane.find({ key: 'pb-20' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /2 messages in 1 conversation$/ })).toBeDefined()
  expect((await pane.find({ key: 'pp-10' }))?.text).toMatch(/^Anna: Ahoj, máš chvilku\?/)
  await pane.press({ key: 'cp-10' }) // the preview line opens the conversation too
  expect(await pane.find({ type: 'Text', text: /máš chvilku/ })).toBeDefined()

  await pane.input({ key: 'reply', text: 'Jasně' })
  expect(sent).toEqual([{ tool: 'twchat-send_message', args: { conversation_id: 10, body: 'Jasně' } }])

  // the Back button in the header returns to the list
  expect((await pane.find({ key: 'back' }))?.text).toBe('│ ← Back │') // a badge, its frame clickable too
  await pane.press({ key: 'back-bottom' })
  expect(await pane.find({ key: 'c-10' })).toBeDefined()

  // the indicator stays, now with nothing unread
  expect(await band.find({ key: 'bb-10' })).toBeUndefined()
  expect(await pane.find({ key: 'pb-10' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: '✓ All caught up' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /no unread/ })).toBeDefined()
})

test('/tw-dm matches name and surname, and never sends the surname as the message', async ($, on) => {
  const sent = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const run = async (args: string) => ((await $.command.run({ command: 'tw-dm', args })) as { text: string }).text

  expect(await run('Filip Čižmár Test')).toBe('Sent to Filip Čižmár.')
  expect(await run('filip cizmar bez diakritiky')).toBe('Sent to Filip Čižmár.')
  expect(await run('Filip ahoj')).toBe('Sent to Filip Čižmár.') // "Filipová" is a surname, not a first-name match
  expect(await run('@marcela ahoj')).toBe('Sent to Marcela Filipová.')
  expect(await run('Filip Čižmár')).toMatch(/^Usage/)
  expect(await run('Nikdo tady')).toMatch(/Nobody/)

  expect(sent.map(s => s.args)).toEqual([
    { user_id: FILIP, body: 'Test' },
    { user_id: FILIP, body: 'bez diakritiky' },
    { user_id: FILIP, body: 'ahoj' },
    { user_id: MARCELA, body: 'ahoj' },
  ])
})

test('focus mode hides the Claude conversation and the band toggles it back', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const row = { plugin: 'teamwork-chat', surface: 'terminal', component: 'AssistantMessage', props: {} as any } as const
  const hidden = await $.ui.mount(row)
  expect(await hidden.find({ type: 'Text', text: 'engine' })).toBeUndefined()

  const band = await $.ui.mount(BAND)
  await band.press({ key: 'tw-focus' })
  const shown = await $.ui.mount(row)
  expect(await shown.find({ type: 'Text', text: 'engine' })).toBeDefined()
})

const done = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

function clipboard(on: On) {
  const ran: string[][] = []
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    if (e.argv[0] === 'powershell.exe') return done('C:\\Temp\\tw-paste-1.png|1280|720|250000\r\n')
    if (e.argv[0] === 'wslpath') return done('/mnt/c/Temp/tw-paste-1.png\n')
    if (e.argv[0] === 'curl') return done('{"tempId":"chat-attachment-abc"}')
    return done()
  })
  return ran
}

async function openConversation($: any) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'tw', args: '' })
  const pane = await $.ui.mount({
    plugin: 'teamwork-chat', surface: 'terminal', component: 'Pane', requestId: 'teamwork-chat',
    props: { title: 'Teamwork Chat', isFocused: true, bodyColumns: 80, placement: 'dock' } as any,
  })
  await pane.press({ key: 'c-10' })
  return pane
}

test('Paste image previews the clipboard image, and Cancel discards the file', async ($, on) => {
  engine(on)
  const ran = clipboard(on)
  mock.env(on, {})
  const pane = await openConversation($)

  await pane.press({ key: 'paste' })
  expect(await pane.find({ type: 'Text', text: /1280×720 · 244 KB/ })).toBeDefined()

  // without an API key it says what to set and keeps the image
  await pane.press({ key: 'image-send' })
  expect(await pane.find({ type: 'Text', text: /teamwork\.env as TEAMWORK_API_KEY/ })).toBeDefined()
  expect(await pane.find({ key: 'image-send' })).toBeDefined()

  await pane.press({ key: 'image-cancel' })
  expect(await pane.find({ key: 'image-send' })).toBeUndefined()
  expect(ran.at(-1)).toEqual(['rm', '-f', '/mnt/c/Temp/tw-paste-1.png'])
})

test('Send uploads the image, then posts the message with its tempId', async ($, on) => {
  engine(on)
  const ran = clipboard(on)
  // the key comes from teamwork.env in the Claude config folder
  mock.env(on, { CLAUDE_CONFIG_DIR: '/home/me/.claude-work' })
  on('fs.read', ($, e) =>
    e.path === '/home/me/.claude-work/teamwork.env'
      ? { value: '# Teamwork\nTEAMWORK_API_KEY="key123"\n' }
      : { deny: 'no such file' })
  const posted: { url: string; auth?: string; body?: string }[] = []
  on('http.fetch', ($, e) => {
    posted.push({ url: e.url, auth: e.init?.headers?.authorization, body: e.init?.body })
    return { value: { status: 201, ok: true, headers: {}, text: '{}' } }
  })
  const pane = await openConversation($)

  await pane.press({ key: 'paste' })
  await pane.press({ key: 'image-send' })

  expect(ran.find(argv => argv[0] === 'curl')).toEqual([
    'curl', '-sS', '--fail-with-body', '--max-time', '60',
    '-F', 'file=@/mnt/c/Temp/tw-paste-1.png;type=image/png', 'https://chat-uploads.teamwork.com/uploads',
  ])
  expect(posted).toEqual([{
    url: 'https://xproduction.teamwork.com/chat/v7/conversations/10/messages',
    auth: `Basic ${btoa('key123:x')}`,
    body: JSON.stringify({ message: { body: '', file: { tempId: 'chat-attachment-abc' } } }),
  }])
  expect(await pane.find({ key: 'image-send' })).toBeUndefined()
})

test('an image message is drawn as a picture, with a download link on the Teamwork site', async ($, on) => {
  const file = {
    id: 777, name: 'shot.png', contentType: 'image/png', bytes: 94557, width: 8, height: 4,
    url: 'https://haproxy-tls-1.us-east-1.elb.amazonaws.com/chat/attachments/777',
    thumbnails: { 160: { constraint: 160, url: 'https://haproxy-tls-1.us-east-1.elb.amazonaws.com/chat/attachments/777/thumbnail?constraint=160' } },
  }
  on('mcp.call', { tool: 'twchat-list_messages' }, () =>
    reply({ messages: [{ id: 101, body: '', createdAt: '2026-10-06T08:00:00.000Z', author: { id: ANNA, fullName: 'Anna Nová' }, file }] }))
  engine(on)
  mock.env(on, { TEAMWORK_API_KEY: 'key123' })
  const ran: { argv: string[]; stdin?: string }[] = []
  on('process.run', ($, e) => {
    ran.push({ argv: [...e.argv], stdin: e.init?.stdin })
    if (e.argv[0] === 'wslpath') return done('\\\\wsl.localhost\\Ubuntu\\tmp\\tw-thumb-777\n')
    // 8 x 4 pixels: top half red, bottom half blue
    if (e.argv[0] === 'powershell.exe') return done('ff0000'.repeat(16) + '0000ff'.repeat(16))
    return done()
  })
  const pane = await openConversation($)

  const download = ran.find(r => r.argv[0] === 'curl')!
  expect(download.argv.at(-1)).toBe('https://xproduction.teamwork.com/chat/attachments/777/thumbnail?constraint=160')
  expect(download.argv.join(' ')).not.toContain('key123') // the key rides on stdin only
  expect(download.stdin).toBe(`header = "Authorization: Basic ${btoa('key123:x')}"\n`)

  const picture = await pane.find({ key: 'pic-777' })
  expect(picture).toBeDefined()
  const href = 'https://xproduction.teamwork.com/chat/attachments/777'
  // the file badge opens the file in the browser; the address stays below as a terminal link
  const badge = await pane.find({ key: 'open-777' })
  expect(badge?.text).toBe('🖼  shot.png · 92 KB ↗')
  expect((await pane.find({ type: 'Link' }))?.props).toMatchObject({ href, label: href })
  await pane.press({ key: 'open-777' })
  expect(ran.at(-1)?.argv).toEqual(['explorer.exe', href])
})

test('pictureSize keeps the aspect ratio in half-block rows', async () => {
  expect(pictureSize({ width: 663, height: 902 })).toEqual({ columns: 48, rows: 16 }) // tall: capped
  expect(pictureSize({ width: 200, height: 100 })).toEqual({ columns: 48, rows: 12 })
  expect(pictureSize({ width: 10, height: 10 })).toEqual({ columns: 10, rows: 5 })
  // one cell: red on top, blue below, as an upper-half block
  const cells = rasterFrom('ff0000' + '0000ff', 1, 1)
  expect(cells).toBe(btoa(String.fromCharCode(0x80, 0x25, 0, 0, 0, 0, 0xff, 0, 0xff, 0, 0, 0)))
})

test('Suggest reply drafts a message from the conversation into the field', async ($, on) => {
  engine(on)
  const asked: { model: string; prompt: string; system?: string }[] = []
  on('model.complete', ($, e) => {
    asked.push({ model: e.model, prompt: e.prompt, system: e.system })
    return {
      value: {
        isAnswered: true, text: '"Jasně, mám chvilku. Co potřebuješ?"',
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }
  })
  const pane = await openConversation($)
  expect(await pane.find({ key: 'clear' })).toBeUndefined() // nothing written yet

  expect(await pane.find({ type: 'Text', text: /\d\d:\d\d$/ })).toBeDefined() // message times stay
  // the frame is as wide as the label row, the two-column ✨ included
  expect((await pane.find({ key: 'suggest-top' }))?.text).toBe(`╭${'─'.repeat(18)}╮`)
  await pane.press({ key: 'suggest-bottom' })

  expect(asked).toHaveLength(1)
  expect(asked[0]!.prompt).toContain('Anna Nová: Ahoj, máš chvilku?')
  expect(asked[0]!.system).toContain('language')
  expect((await pane.find({ type: 'Input', key: 'reply' }))?.text).toBe('Jasně, mám chvilku. Co potřebuješ?')

  // ✕ beside the field empties it: a fresh, empty field takes its place, and ✕ hides again
  expect(await pane.find({ key: 'clear' })).toBeDefined() // shown for the suggestion
  await pane.press({ key: 'clear' })
  expect(await pane.find({ type: 'Input', key: 'reply' })).toBeUndefined()
  expect((await pane.find({ type: 'Input', key: 'reply-1' }))?.text ?? '').toBe('')
  expect(await pane.find({ key: 'clear' })).toBeUndefined()

  // typing shows it, emptying the field by hand hides it
  await pane.input({ key: 'reply-1', text: 'a', kind: 'change' })
  expect(await pane.find({ key: 'clear' })).toBeDefined()
  await pane.input({ key: 'reply-1', text: '', kind: 'change' })
  expect(await pane.find({ key: 'clear' })).toBeUndefined()
})

test('columnsOf counts wide emoji as two columns, so badge frames line up', async () => {
  expect(columnsOf(' All ')).toBe(5)
  expect(columnsOf(' ✨ Suggest reply ')).toBe(18) // ✨ is two columns
  expect(columnsOf(' 📋 Paste image ')).toBe(16)
  expect(columnsOf(' ← Back ')).toBe(8)
  expect(columnsOf(' ⟳ Refresh ')).toBe(11)
})
