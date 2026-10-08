import fs from 'node:fs'

// The public catalogue contains model labels only, never a deployment address or credentials.
const catalogue = JSON.parse(fs.readFileSync(new URL('../../resources/speech/voices.json', import.meta.url), 'utf8'))
export const VOICE_GAMES = Object.freeze([
  {id:'genshin',name:'原神',aliases:['原神','genshin','genshin impact']},
  {id:'honkai3',name:'崩坏3',aliases:['崩坏3','崩坏三','崩坏','honkai3','honkai impact 3rd','bh3']},
  {id:'umamusume',name:'赛马娘',aliases:['赛马娘','马娘','uma','umamusume']},
  {id:'other',name:'其他/未分类',aliases:['其他','未分类','其他/未分类','other']}
].map(game=>Object.freeze({...game,aliases:Object.freeze(game.aliases)})))
const key = value=>String(value??'').normalize('NFKC').trim().toLowerCase().replace(/\s+/g,'')
export function normalizeGame(value) {
  const query=key(value)
  return VOICE_GAMES.find(game=>key(game.id)===query||game.aliases.some(alias=>key(alias)===query))?.id??null
}
const voices=Object.freeze(catalogue.voices.map(voice=>Object.freeze({...voice,aliases:Object.freeze(voice.aliases)})))
export function listVoices({game,search,page=1,pageSize=30,language}={}) {
  const gameId=game?normalizeGame(game):null, query=key(search)
  const filtered=voices.filter(voice=>(!game||voice.game===gameId)&&(!language||voice.language===language)&&(!query||[voice.label,voice.name,...voice.aliases].some(value=>key(value).includes(query))))
  pageSize=Math.min(100,Math.max(1,Math.trunc(Number(pageSize))||30))
  const pages=Math.max(1,Math.ceil(filtered.length/pageSize))
  // Preserve an out-of-range request so callers can report it instead of repeating the last page.
  page=Number.isSafeInteger(Number(page))&&Number(page)>0?Number(page):1
  return {voices:filtered.slice((page-1)*pageSize,page*pageSize),total:filtered.length,page,pageSize,pages,games:VOICE_GAMES}
}
export function resolveVoice(name,{game,language='zh'}={}) {
  const query=key(typeof name==='object'?name?.label:name)
  if(!query)return null
  const gameId=game?normalizeGame(game):null
  const candidates=voices.filter(voice=>!game||voice.game===gameId)
  // Full labels always win, including an explicitly requested Japanese label.
  const exact=candidates.find(voice=>key(voice.label)===query)
  if(exact)return exact
  const matches=candidates.filter(voice=>[voice.name,...voice.aliases].some(value=>key(value)===query))
  const preferred=matches.filter(voice=>voice.language===language)
  if(preferred.length===1)return preferred[0]
  if(matches.length===1)return matches[0]
  // A typo or an ambiguous substring must never silently select a different character.
  return null
}
