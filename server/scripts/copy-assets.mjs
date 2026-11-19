// Non-TS assets under src/ that the build must carry into dist/.
import { cpSync } from 'node:fs'
cpSync('src/chat/prompt.md', 'dist/chat/prompt.md')
