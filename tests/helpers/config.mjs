import { defaults, merge } from '../../src/core/config.mjs'

// Unrelated unit fixtures do not configure an external moderation provider.
// Production defaults stay enabled; moderation integration has separate tests.
export function unmoderatedTestConfig(value = {}) {
  return merge(defaults, merge({ security: { inputModeration: { enabled: false } } }, value))
}
