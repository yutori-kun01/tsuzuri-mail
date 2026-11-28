/** ブラウザ側：ArrayBuffer と base64url の変換と、WebAuthn の呼び出し */
export const WEBAUTHN_CLIENT = `function tzB64(b){var s='',a=new Uint8Array(b);for(var i=0;i<a.length;i++)s+=String.fromCharCode(a[i]);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')}
function tzBuf(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';var r=atob(s),a=new Uint8Array(r.length);for(var i=0;i<r.length;i++)a[i]=r.charCodeAt(i);return a.buffer}
function tzPost(u,b){return fetch(u,{method:'POST',credentials:'same-origin',headers:b?{'content-type':'application/json'}:{},body:b?JSON.stringify(b):undefined}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'エラーが起きました');return j})})}
function tzErr(e){if(e&&e.name==='NotAllowedError')return 'キャンセルされたか、時間切れになりました。';if(e&&e.name==='InvalidStateError')return 'このパスキーはもう登録されています。';if(e&&e.name==='SecurityError')return 'この URL ではパスキーを使えません（公開用の https の URL で開いてください）。';return (e&&e.message)||'エラーが起きました'}`;

