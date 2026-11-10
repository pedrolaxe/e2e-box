import { NextResponse, type NextRequest } from 'next/server'

// O painel controla o celular e grava arquivos: só aceita chamadas da própria página.
// - Host precisa ser local (barra DNS rebinding: outro domínio apontando para 127.0.0.1).
// - Em métodos que mudam algo, o Origin precisa ser o mesmo host e o corpo JSON: um site
//   qualquer não consegue mandar `application/json` para cá sem passar pelo preflight de CORS.
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/

export function middleware(req: NextRequest) {
  const host = req.headers.get('host') ?? ''
  if (!LOCAL_HOST.test(host)) return NextResponse.json({ error: 'host não permitido' }, { status: 403 })

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.get('origin')
    let originHost = ''
    try {
      originHost = origin ? new URL(origin).host : ''
    } catch {
      originHost = ''
    }
    if (originHost !== host) return NextResponse.json({ error: 'origem não permitida' }, { status: 403 })
    const type = req.headers.get('content-type') ?? ''
    if (req.method !== 'DELETE' && !type.startsWith('application/json')) {
      return NextResponse.json({ error: 'envie application/json' }, { status: 415 })
    }
  }
  return NextResponse.next()
}

export const config = { matcher: '/api/:path*' }
