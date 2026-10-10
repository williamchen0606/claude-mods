/** How many times clef-verify sent Claude back during one prompt of the person's. */
export type Retries = { prompt: string; count: number }

declare module 'claude-code' {
  interface PluginState {
    'clef-verify': {
      /** The prompt the count belongs to (its turn number and opening text), and the count; null before the first send-back. */
      retries: Retries | null
    }
  }
}
