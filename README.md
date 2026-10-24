# 舌戰（多人連線版）

## 檔案
- `server.js`：遊戲伺服器（房間、抓人、拉扯、繞柱斷線、吃人、計分、比賽時間）
- `public/index.html`：遊戲本體（單人的勾爪練習、對戰電腦，也都還在）
- `package.json`：告訴主機要安裝哪些套件、怎麼啟動

## 在自己電腦上測試
1. 安裝 Node.js 18 以上
2. 在這個資料夾執行 `npm install`，再執行 `npm start`
3. 打開 http://localhost:3000 → 多人對戰 → 加入
4. 再開一個分頁（或同一個 Wi-Fi 的手機、朋友電腦用 http://你的電腦IP:3000）加入同一個房間

## 部署到 Render（網頁服務）
1. 把 `server.js`、`package.json`、`README.md` 和整個 `public` 資料夾上傳到 GitHub 倉庫
   （GitHub 網頁的上傳頁面可以直接把資料夾拖進去）
2. Render 後台 → + New → **Web Service** → 選這個倉庫
3. 設定：
   - Region：**Singapore**（離台灣最近，建立後不能改）
   - Runtime：Node
   - Build Command：`npm install`
   - Start Command：`npm start`
   - Instance Type：Free
4. 部署完成後，用它給的 ○○○.onrender.com 網址打開，就是多人版

免費方案閒置 15 分鐘會休眠，第一個人連進來要等大約一分鐘開機。

## 規則參數
都在 `server.js` 最上面，例如一場幾秒（MATCH_TIME）、拉人速度（PULL_BASE）、每個房間最多幾人（MAX_PLAYERS）。
