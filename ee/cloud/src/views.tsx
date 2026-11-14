/** @jsxImportSource hono/jsx */
import { brandFontsCss } from '@openparley/brand';
import type { Child } from 'hono/jsx';

export const STYLE = `${brandFontsCss()}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 'Plus Jakarta Sans',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#14181f;background:#fbf7ee;accent-color:#2c7f6b}
.logo{display:block}.logo img{display:block;height:30px;width:auto}
main{max-width:760px;margin:0 auto;padding:32px 20px 64px}h1{font-size:24px;margin:0 0 16px}h2{font-size:18px;margin:0 0 4px}
a{color:#1f5a4c}code,pre{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f3ecdc;border-radius:4px;padding:1px 4px}
pre{padding:10px;white-space:pre-wrap;word-break:break-all}
section,.box{background:#fff;border:1px solid #e7dec9;border-radius:20px;padding:16px;margin:0 0 12px;box-shadow:0 8px 24px -8px rgb(90 67 16 / 0.08)}
label{display:block;font-weight:600;margin:12px 0 4px}input{font:inherit;width:100%;padding:8px 10px;border:1px solid #cfc3a8;border-radius:12px;background:#fff}
input:focus{outline:none;border-color:#2c7f6b;box-shadow:0 0 0 0.5px #2c7f6b}
button,.button{display:inline-block;font:inherit;font-weight:700;padding:8px 16px;border-radius:999px;border:1px solid #2c7f6b;background:#2c7f6b;color:#fff;cursor:pointer;margin-top:12px;text-decoration:none}
.muted{color:#5e6672}.error{background:#fbe6df;border:1px solid #e8846b;color:#14181f;padding:10px 12px;border-radius:12px}
header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}footer{margin-top:40px;font-size:14px}footer a{color:inherit}
.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:24px 0}.plans section{margin:0}.price{font-size:20px;font-weight:700;margin:0}
.address{display:flex;align-items:center;gap:6px}.address input{flex:1}.address span{white-space:nowrap}
fieldset{border:0;padding:0;margin:12px 0 0}legend{font-weight:600;margin-bottom:4px;padding:0}
.choice{display:flex;gap:8px;align-items:center;font-weight:400;margin:6px 0}.choice input{width:auto}
.ok{background:#ddf1ea;border:1px solid #7cc7b2;padding:10px 12px;border-radius:12px}
.button.github{background:#14181f;border-color:#14181f}button.secondary,.button.secondary{background:#fff;color:#14181f;border-color:#cfc3a8}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.row>*{margin:0}.or{display:flex;gap:12px;align-items:center;color:#5e6672;margin:16px 0 0}.or::before,.or::after{content:'';flex:1;border-top:1px solid #e7dec9}
table{width:100%;border-collapse:collapse}td{padding:10px 4px;border-top:1px solid #e7dec9;vertical-align:middle}tr:first-child td{border-top:0}td.actions{text-align:right}td.actions .button{margin:0}
`;

/** `aside` sits in the header next to the logo (the signed-in account, Sign out). */
export function Page({ title, head, siteUrl, aside, children }: { title: string; head?: Child; siteUrl?: string | null; aside?: Child; children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="same-origin" />
        <title>{title} · OpenParley</title>
        <link rel="icon" href="/brand/favicon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/brand/apple-touch-icon.png" />
        <style dangerouslySetInnerHTML={{ __html: STYLE }} />
        {head}
      </head>
      <body>
        <main>
          <header>
            <a class="logo" href="/">
              <img src="/brand/logo-light.svg" alt="OpenParley" width="124" height="30" />
            </a>
            {aside}
          </header>
          {children}
          {siteUrl && (
            <footer class="muted">
              <a href={`${siteUrl}/imprint`}>Imprint</a> · <a href={`${siteUrl}/terms`}>Terms</a> · <a href={`${siteUrl}/privacy`}>Privacy</a> ·{' '}
              <a href={`${siteUrl}/dpa`}>DPA</a>
            </footer>
          )}
        </main>
      </body>
    </html>
  );
}

export function Message({ title, children }: { title: string; children: Child }) {
  return (
    <Page title={title}>
      <h1>{title}</h1>
      <p>{children}</p>
    </Page>
  );
}

