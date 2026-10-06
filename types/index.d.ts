export type TwConversation = {
  id: number
  title: string
  type: string
  latestId: number
  latestAuthorId: number | null
  latestAuthor: string
  latestBody: string
  latestAt: string
  lastViewedId: number
  unreadCount: number
  memberCount: number
}

export type TwFile = {
  id: number
  name: string
  url: string
  contentType: string
  bytes: number
  width: number
  height: number
  thumbnail: string | null
}

export type TwMessage = {
  id: number
  author: string
  authorId: number
  body: string
  createdAt: string
  file: TwFile | null
}

export type TwRaster = { columns: number; rows: number; cells: string }

export type TwPicture = TwRaster | 'loading' | 'failed'

export type TwPastedImage = {
  path: string
  width: number
  height: number
  bytes: number
}

export type TwPerson = { id: number; name: string; handle: string }

export type TwView =
  | { mode: 'all' }
  | { mode: 'unread' }
  | { mode: 'people' }
  | { mode: 'conv'; convId: number; title: string }

declare module 'claude-code' {
  interface PluginState {
    'teamwork-chat': {
      convs: TwConversation[]
      seen: Record<string, number>
      me: number | null
      view: TwView
      messages: TwMessage[]
      people: TwPerson[]
      error: string | null
      isBusy: boolean
      isFocus: boolean
      pasted: TwPastedImage | null
      siteUrl: string | null
      pictures: Record<string, TwPicture>
      suggestion: { convId: number; text: string } | null
      isSuggesting: boolean
    }
  }
}
