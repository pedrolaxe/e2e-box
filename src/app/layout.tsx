import type { Metadata } from 'next'
import { JetBrains_Mono } from 'next/font/google'
import { cookies, headers } from 'next/headers'
import { I18nProvider } from '@/lib/i18n'
import { LANG_COOKIE, pickLang } from '@/lib/lang'
import './globals.css'

const mono = JetBrains_Mono({ variable: '--font-jetbrains', subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'e2e-box',
  description: 'End-to-end testing for native Android apps over adb, with Maestro-style YAML flows',
}

// Aplica o tema antes da primeira pintura: escolha salva ou, sem ela, o tema do sistema.
const themeScript = `try{var t=localStorage.getItem('e2e-box:theme');if(t!=='light'&&t!=='dark')t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='dark'}`

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Idioma: cookie da escolha no painel ou, sem ele, o do navegador.
  const lang = pickLang((await cookies()).get(LANG_COOKIE)?.value, (await headers()).get('accept-language'))
  return (
    <html lang={lang} className={mono.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <I18nProvider initial={lang}>{children}</I18nProvider>
      </body>
    </html>
  )
}
