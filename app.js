const express = require("express");
const path = require("path");
const app = express();
const mysql = require("mysql2");
const session = require("express-session");
const bcrypt = require("bcrypt");
const axios = require("axios");

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static("public"));
app.use(express.urlencoded({ extended: false }));
app.use(
  session({
    secret: "secret",
    resave: false,
    saveUninitialized: false,
  }),
);

const connection = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: {
    rejectUnauthorized: false,
  },
});

connection.query("SELECT 1", (err) => {
  if (err) {
    console.error("MySQL接続エラー:", err);
  } else {
    console.log("MySQLに接続しました");
  }
});

// Google Books APIから情報を取得する共通関数
async function fetchBookFromGoogle(comicName, volume) {
  const normalizedComicName = (comicName || "").replace(/[（）()]/g, "").trim();
  const volumeText = volume ? `${volume}` : "";
  const queries = [
    `intitle:${normalizedComicName} ${volumeText}`,
    `intitle:${normalizedComicName}`,
    `${normalizedComicName} ${volumeText}`,
    normalizedComicName,
  ].filter(Boolean);

  const baseParams = {
    maxResults: 10,
    langRestrict: "ja",
    printType: "books",
  };

  if (process.env.GOOGLE_BOOKS_API_KEY) {
    baseParams.key = process.env.GOOGLE_BOOKS_API_KEY;
  }

  for (const query of queries) {
    try {
      const response = await axios.get(
        "https://www.googleapis.com/books/v1/volumes",
        {
          params: {
            ...baseParams,
            q: query,
          },
          timeout: 8000,
        },
      );

      const items = response.data.items || [];

      if (items.length === 0) {
        continue;
      }

      let target = items.find((item) => {
        const title = item.volumeInfo?.title || "";
        const normalizedTitle = title.replace(/[（）()]/g, "");

        return (
          normalizedTitle.includes(normalizedComicName) &&
          (!volumeText ||
            normalizedTitle.includes(volumeText) ||
            normalizedTitle.includes(`${volumeText}巻`) ||
            normalizedTitle.includes(`第${volumeText}巻`))
        );
      });

      if (!target) {
        target = items.find((item) => {
          const title = item.volumeInfo?.title || "";
          return title.includes(normalizedComicName);
        });
      }

      if (!target) {
        target = items[0];
      }

      const book = target.volumeInfo || {};
      let imageUrl = "";
      let isbn = "";

      if (book.imageLinks) {
        imageUrl =
          book.imageLinks.thumbnail || book.imageLinks.smallThumbnail || "";
        imageUrl = imageUrl.replace("http://", "https://");
      }

      if (!imageUrl && book.industryIdentifiers) {
        const isbnObj = book.industryIdentifiers.find(
          (id) => id.type === "ISBN_13" || id.type === "ISBN_10",
        );

        if (isbnObj) {
          isbn = isbnObj.identifier;
          imageUrl = `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`;
        }
      }

      if (!imageUrl && book.industryIdentifiers) {
        const isbnObj = book.industryIdentifiers.find(
          (id) => id.type === "ISBN_13" || id.type === "ISBN_10",
        );

        if (isbnObj) {
          isbn = isbnObj.identifier;
        }
      }

      return {
        author: book.authors?.join(", ") || "",
        publisher: book.publisher || "",
        imageUrl,
        isbn,
      };
    } catch (error) {
      console.warn(`Google Books API検索失敗 (${query}):`, error.message);
    }
  }

  return {
    author: "",
    publisher: "",
    imageUrl: "",
    isbn: "",
  };
}

async function ensureVolumeImageUrl(comicId, comicName, volume) {
  const [rows] = await connection
    .promise()
    .query(
      `SELECT id, image_url FROM comic_volumes WHERE comic_id = ? AND volume = ?`,
      [comicId, volume],
    );

  if (rows.length === 0) {
    return "";
  }

  if (rows[0].image_url && rows[0].image_url.trim() !== "") {
    return rows[0].image_url;
  }

  const bookInfo = await fetchBookFromGoogle(comicName, volume);

  if (bookInfo.imageUrl) {
    await connection
      .promise()
      .query(`UPDATE comic_volumes SET image_url = ? WHERE id = ?`, [
        bookInfo.imageUrl,
        rows[0].id,
      ]);
    return bookInfo.imageUrl;
  }

  return "";
}

async function createNotification(userId, message) {
  if (!userId || !message) {
    return;
  }

  await connection
    .promise()
    .query(`INSERT INTO notifications (user_id, message) VALUES (?, ?)`, [
      userId,
      message,
    ]);
}

async function markNotificationAsRead(notificationId, userId) {
  if (!notificationId || !userId) {
    return;
  }

  await connection
    .promise()
    .query(
      `UPDATE notifications SET is_read = TRUE WHERE id = ? AND user_id = ?`,
      [notificationId, userId],
    );
}

async function checkAndSendDueDateNotifications(userId) {
  if (!userId) {
    return;
  }

  try {
    const [rows] = await connection.promise().query(
      `SELECT
         l.id,
         l.borrower_id,
         l.lender_id,
         l.due,
         l.notified_3days,
         l.notified_1day,
         c.comic_name,
         u.username AS counterpart_name
       FROM lending l
       JOIN comic_owning co ON l.owning_id = co.id
       JOIN comics c ON co.comic_id = c.id
       LEFT JOIN users u ON u.id = CASE
         WHEN l.borrower_id = ? THEN l.lender_id
         ELSE l.borrower_id
       END
       WHERE l.status = 'lending'
         AND (l.borrower_id = ? OR l.lender_id = ?)
       ORDER BY l.due ASC`,
      [userId, userId, userId],
    );

    const now = new Date();
    const oneDayMs = 1000 * 60 * 60 * 24;

    for (const row of rows) {
      const dueDate = new Date(row.due);
      const daysLeft = Math.ceil((dueDate - now) / oneDayMs);

      if (daysLeft <= 3 && daysLeft > 1 && !row.notified_3days) {
        const counterpartLabel = row.counterpart_name || "相手";
        await createNotification(
          userId,
          `${row.comic_name}（${counterpartLabel}）の返却期限まで残り${daysLeft}日です。お忘れなく返却してください。`,
        );
        await connection
          .promise()
          .query(`UPDATE lending SET notified_3days = TRUE WHERE id = ?`, [
            row.id,
          ]);
      }

      if (daysLeft <= 1 && !row.notified_1day) {
        const counterpartLabel = row.counterpart_name || "相手";
        await createNotification(
          userId,
          `${row.comic_name}（${counterpartLabel}）の返却期限まで残り${daysLeft}日です。今日中に返却してください。`,
        );
        await connection
          .promise()
          .query(`UPDATE lending SET notified_1day = TRUE WHERE id = ?`, [
            row.id,
          ]);
      }
    }
  } catch (err) {
    console.warn("期限通知のチェックに失敗しました:", err.message);
  }
}

app.use((req, res, next) => {
  if (req.session.userId === undefined) {
    res.locals.username = "ゲスト";
    res.locals.isLoggedIn = false;
  } else {
    res.locals.username = req.session.username;
    res.locals.isLoggedIn = true;
  }
  next();
});

app.get("/", (req, res) => {
  res.render("top.ejs");
});

app.get("/login", (req, res) => {
  if (req.session.userId === undefined) {
    res.render("login.ejs");
  } else {
    res.redirect("/home");
  }
});

app.post("/login", async (req, res) => {
  const email = req.body.email;

  try {
    const [results] = await connection
      .promise()
      .query("SELECT * FROM users WHERE email = ?", [email]);

    if (results.length > 0) {
      const plain = req.body.password;
      const hash = results[0].password;
      const isEqual = await bcrypt.compare(plain, hash);

      if (isEqual) {
        req.session.userId = results[0].id;
        req.session.username = results[0].username;
        await checkAndSendDueDateNotifications(results[0].id);
        return res.redirect("/home");
      }

      return res.send("パスワードが違います");
    }

    return res.send("メールアドレスが見つかりません");
  } catch (err) {
    console.error(err);
    return res.send(err);
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error(err);
      return res.send(err);
    }
    res.redirect("/");
  });
});

app.get("/signup", (req, res) => {
  if (req.session.userId) {
    return res.redirect("/home");
  }
  res.render("signup.ejs");
});

app.post("/signup", (req, res) => {
  const username = req.body.username;
  const email = req.body.email;
  const password = req.body.password;

  bcrypt.hash(password, 10, (err, hash) => {
    if (err) {
      console.error(err);
      return res.send(err);
    }

    // ユーザー登録
    connection.query(
      "INSERT INTO users (username, email, password) VALUES (?, ?, ?)",
      [username, email, hash],
      (err, results) => {
        if (err) {
          console.error(err);
          return res.send(err);
        }

        const userId = results.insertId;

        // 初期グループを作成
        connection.query(
          "INSERT INTO user_groups (group_name, owner_id) VALUES (?, ?)",
          [`${username}のマイグループ`, userId],
          (err, results) => {
            if (err) {
              console.error(err);
              return res.send(err);
            }

            const groupId = results.insertId;

            // 作成者をグループメンバーに追加
            connection.query(
              "INSERT INTO group_members (group_id, user_id) VALUES (?, ?)",
              [groupId, userId],
              (err) => {
                if (err) {
                  console.error(err);
                  return res.send(err);
                }

                // ログイン状態にする
                req.session.userId = userId;
                req.session.username = username;

                res.redirect("/home");
              },
            );
          },
        );
      },
    );
  });
});

app.get("/home", async (req, res) => {
  if (req.session.userId === undefined) {
    return res.redirect("/login");
  }

  try {
    const [notifications] = await connection.promise().query(
      `SELECT id, message, created_at, is_read
       FROM notifications
       WHERE user_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 10`,
      [req.session.userId],
    );

    res.render("home.ejs", {
      username: req.session.username,
      notifications,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("通知の取得に失敗しました");
  }
});

app.post("/notifications/:notificationId/read", async (req, res) => {
  if (req.session.userId === undefined) {
    return res.redirect("/login");
  }

  const notificationId = Number(req.params.notificationId);

  if (Number.isNaN(notificationId)) {
    return res.status(400).send("不正な通知IDです");
  }

  try {
    await markNotificationAsRead(notificationId, req.session.userId);
    return res.redirect("/home");
  } catch (err) {
    console.error(err);
    return res.status(500).send("通知の更新に失敗しました");
  }
});

app.post("/notifications/read-all", async (req, res) => {
  if (req.session.userId === undefined) {
    return res.status(401).send("ログインが必要です");
  }

  try {
    await connection
      .promise()
      .query(
        `UPDATE notifications SET is_read = TRUE WHERE user_id = ? AND is_read = FALSE`,
        [req.session.userId],
      );
    return res.sendStatus(200);
  } catch (err) {
    console.error(err);
    return res.status(500).send("通知の更新に失敗しました");
  }
});

app.get("/borrowed", async (req, res) => {
  if (req.session.userId === undefined) {
    return res.redirect("/login");
  }

  try {
    const [borrowed] = await connection.promise().query(
      `SELECT
         l.id,
         l.due,
         l.borrowed_at,
         c.comic_name,
         co.volume,
         u.username AS lender_name,
         cv.image_url
       FROM lending l
       JOIN comic_owning co ON l.owning_id = co.id
       JOIN comics c ON co.comic_id = c.id
       JOIN comic_volumes cv ON cv.comic_id = co.comic_id AND cv.volume = co.volume
       JOIN users u ON l.lender_id = u.id
       WHERE l.borrower_id = ?
         AND l.status = 'lending'
       ORDER BY l.due ASC`,
      [req.session.userId],
    );

    res.render("borrowed.ejs", {
      username: req.session.username,
      borrowed,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("借りている本の取得に失敗しました");
  }
});

app.get("/lent", async (req, res) => {
  if (req.session.userId === undefined) {
    return res.redirect("/login");
  }

  try {
    const [lent] = await connection.promise().query(
      `SELECT
         l.id,
         l.due,
         l.borrowed_at,
         c.comic_name,
         co.volume,
         u.username AS borrower_name,
         cv.image_url
       FROM lending l
       JOIN comic_owning co ON l.owning_id = co.id
       JOIN comics c ON co.comic_id = c.id
       JOIN comic_volumes cv ON cv.comic_id = co.comic_id AND cv.volume = co.volume
       JOIN users u ON l.borrower_id = u.id
       WHERE l.lender_id = ?
         AND l.status = 'lending'
       ORDER BY l.due ASC`,
      [req.session.userId],
    );

    res.render("lent.ejs", {
      username: req.session.username,
      lent,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("貸している本の取得に失敗しました");
  }
});

app.get("/return/:lendingId", async (req, res) => {
  if (req.session.userId === undefined) {
    return res.redirect("/login");
  }

  const lendingId = Number(req.params.lendingId);

  if (Number.isNaN(lendingId)) {
    return res.status(400).send("不正な貸し出しIDです");
  }

  try {
    const [rows] = await connection.promise().query(
      `SELECT
         l.id,
         c.comic_name,
         co.volume,
         u.username AS lender_name,
         l.due
       FROM lending l
       JOIN comic_owning co ON l.owning_id = co.id
       JOIN comics c ON co.comic_id = c.id
       JOIN users u ON l.lender_id = u.id
       WHERE l.id = ?
         AND l.borrower_id = ?
         AND l.status = 'lending'`,
      [lendingId, req.session.userId],
    );

    if (rows.length === 0) {
      return res.status(404).send("対象の貸し出し情報が見つかりません");
    }

    res.render("return.ejs", {
      username: req.session.username,
      lending: rows[0],
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("返却ページの表示に失敗しました");
  }
});

app.post("/return/:lendingId", async (req, res) => {
  if (req.session.userId === undefined) {
    return res.redirect("/login");
  }

  const lendingId = Number(req.params.lendingId);

  if (Number.isNaN(lendingId)) {
    return res.status(400).send("不正な貸し出しIDです");
  }

  try {
    const [lendingRows] = await connection.promise().query(
      `SELECT
         l.lender_id,
         c.comic_name,
         u.username AS borrower_name
       FROM lending l
       JOIN comic_owning co ON l.owning_id = co.id
       JOIN comics c ON co.comic_id = c.id
       JOIN users u ON l.borrower_id = u.id
       WHERE l.id = ?
         AND l.borrower_id = ?
         AND l.status = 'lending'`,
      [lendingId, req.session.userId],
    );

    if (lendingRows.length === 0) {
      return res.status(404).send("対象の貸し出し情報が見つかりません");
    }

    await connection.promise().query(
      `UPDATE lending
       SET status = 'returned', returned_at = CURRENT_TIMESTAMP
       WHERE id = ? AND borrower_id = ? AND status = 'lending'`,
      [lendingId, req.session.userId],
    );

    const {
      lender_id: lenderId,
      comic_name: comicName,
      borrower_name: borrowerName,
    } = lendingRows[0];

    await createNotification(
      req.session.userId,
      `返却を完了しました。貸し出し記録を更新しました。`,
    );
    await createNotification(
      lenderId,
      `${borrowerName}さんが「${comicName}」を返却しました。`,
    );

    res.redirect("/borrowed");
  } catch (err) {
    console.error(err);
    res.status(500).send("返却処理に失敗しました");
  }
});

app.get("/list", (req, res) => {
  if (req.session.userId === undefined) {
    return res.redirect("/login");
  }

  const groupId = req.query.group_id || "";
  const search = req.query.search || "";

  // 1. グループ一覧を取得
  connection.query(
    `SELECT user_groups.id, user_groups.group_name
     FROM user_groups
     JOIN group_members
       ON user_groups.id = group_members.group_id
     WHERE group_members.user_id = ?`,
    [req.session.userId],
    (err, groups) => {
      if (err) {
        console.error(err);
        return res.send(err);
      }

      // 2. 漫画一覧 ＆ 表紙画像取得用SQL（1番若い巻の画像を優先取得）
      let sql = `
        SELECT DISTINCT 
          comics.id, 
          comics.comic_name,
          v.image_url
        FROM comics
        JOIN comic_owning
          ON comics.id = comic_owning.comic_id
        JOIN group_members
          ON comic_owning.group_id = group_members.group_id
        LEFT JOIN (
          /* 各漫画の中で最小のvolume（1巻など）の画像を1つだけ取得するサブクエリ */
          SELECT cv1.comic_id, cv1.image_url
    FROM comic_volumes cv1
    WHERE cv1.image_url IS NOT NULL
      AND cv1.image_url <> ''
      AND cv1.volume = (
          SELECT MIN(cv2.volume)
          FROM comic_volumes cv2
          WHERE cv2.comic_id = cv1.comic_id
            AND cv2.image_url IS NOT NULL
            AND cv2.image_url <> ''
      )
        ) v ON comics.id = v.comic_id
        WHERE group_members.user_id = ?
      `;

      const params = [req.session.userId];

      // グループで絞り込み
      if (groupId !== "") {
        sql += " AND comic_owning.group_id = ?";
        params.push(groupId);
      }

      // 漫画名で検索
      if (search !== "") {
        sql += " AND comics.comic_name LIKE ?";
        params.push(`%${search}%`);
      }

      connection.query(sql, params, async (err, comics) => {
        if (err) {
          console.error(err);
          return res.send(err);
        }

        // デフォルト画像の表示設定
        const defaultImage =
          "https://via.placeholder.com/150x200?text=No+Image";

        const comicsWithImage = await Promise.all(
          comics.map(async (comic) => {
            let imageUrl = comic.image_url || "";

            if (!imageUrl || imageUrl.trim() === "") {
              imageUrl = await ensureVolumeImageUrl(
                comic.id,
                comic.comic_name,
                1,
              );
            }

            return {
              ...comic,
              image_url:
                imageUrl && imageUrl.trim() !== "" ? imageUrl : defaultImage,
            };
          }),
        );

        res.render("list.ejs", {
          comics: comicsWithImage,
          groups: groups,
          selectedGroupId: groupId,
          search: search,
          successMessage:
            req.query.success === "1"
              ? "選択した漫画をまとめて貸し出ししました。"
              : null,
          errorMessage: req.query.error ? req.query.error : null,
        });
      });
    },
  );
});

app.post("/lend-multiple", async (req, res) => {
  if (req.session.userId === undefined) {
    return res.redirect("/login");
  }

  const borrowerEmail = (req.body.borrower_email || "").trim();
  const dueDays = Number(req.body.due_days || 7);
  const rawComicIds = Array.isArray(req.body.comic_ids)
    ? req.body.comic_ids
    : req.body.comic_ids
      ? [req.body.comic_ids]
      : [];
  const comicIds = rawComicIds
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);

  if (!borrowerEmail) {
    return res.redirect(
      "/list?error=" + encodeURIComponent("借りる相手のメールアドレスを入力してください"),
    );
  }

  if (!Number.isFinite(dueDays) || dueDays <= 0) {
    return res.redirect(
      "/list?error=" + encodeURIComponent("返却日数は1以上で指定してください"),
    );
  }

  if (comicIds.length === 0) {
    return res.redirect(
      "/list?error=" + encodeURIComponent("貸し出しする漫画を選択してください"),
    );
  }

  try {
    const db = connection.promise();
    await db.beginTransaction();

    const [userRows] = await db.query(
      `SELECT id, username FROM users WHERE email = ?`,
      [borrowerEmail],
    );

    if (userRows.length === 0) {
      await db.rollback();
      return res.redirect(
        "/list?error=" + encodeURIComponent("指定されたメールアドレスのユーザーが見つかりません"),
      );
    }

    const borrowerId = userRows[0].id;
    const borrowerName = userRows[0].username || borrowerEmail;
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + dueDays);
    const dueDateString = dueDate.toISOString().slice(0, 10);
    const lendTargets = [];

    for (const comicId of comicIds) {
      const [owningRows] = await db.query(
        `SELECT co.id, c.comic_name
         FROM comic_owning co
         JOIN comics c ON c.id = co.comic_id
         JOIN group_members gm ON gm.group_id = co.group_id
         WHERE c.id = ?
           AND gm.user_id = ?
         ORDER BY co.volume ASC, co.id ASC
         LIMIT 1`,
        [comicId, req.session.userId],
      );

      if (owningRows.length === 0) {
        continue;
      }

      const owningId = owningRows[0].id;
      const comicName = owningRows[0].comic_name || "漫画";

      const [activeLendingRows] = await db.query(
        `SELECT id FROM lending WHERE owning_id = ? AND status = 'lending'`,
        [owningId],
      );

      if (activeLendingRows.length > 0) {
        await db.rollback();
        return res.redirect(
          "/list?error=" + encodeURIComponent(`「${comicName}」はすでに貸し出し中です。`),
        );
      }

      lendTargets.push({ owningId, comicName });
    }

    if (lendTargets.length === 0) {
      await db.rollback();
      return res.redirect(
        "/list?error=" + encodeURIComponent("貸し出し可能な漫画がありません"),
      );
    }

    for (const target of lendTargets) {
      await db.query(
        `INSERT INTO lending (owning_id, borrower_id, lender_id, due, status)
         VALUES (?, ?, ?, ?, 'lending')`,
        [target.owningId, borrowerId, req.session.userId, dueDateString],
      );
    }

    await db.commit();

    for (const target of lendTargets) {
      await createNotification(
        borrowerId,
        `${borrowerName}さんが「${target.comicName}」を借り受けました。返却期限は ${dueDateString} です。`,
      );
      await createNotification(
        req.session.userId,
        `${borrowerName}さんに「${target.comicName}」を貸し出しました。返却期限は ${dueDateString} です。`,
      );
    }

    res.redirect("/list?success=1");
  } catch (err) {
    console.error(err);
    try {
      await connection.promise().rollback();
    } catch (rollbackErr) {
      console.error(rollbackErr);
    }
    res.redirect(
      "/list?error=" + encodeURIComponent("貸し出し登録に失敗しました"),
    );
  }
});

// 例: 各漫画の巻一覧ページ (/comics/:id)
app.get("/comics/:id", async (req, res) => {
  if (req.session.userId === undefined) {
    return res.redirect("/login");
  }

  const comicId = Number(req.params.id);

  if (Number.isNaN(comicId)) {
    return res.status(400).send("不正な漫画IDです");
  }

  try {
    // 漫画情報取得（ユーザーが所属するグループの漫画のみ取得）
    const [comics] = await connection.promise().query(
      `
      SELECT DISTINCT c.*
      FROM comics c
      JOIN comic_owning co
        ON c.id = co.comic_id
      JOIN group_members gm
        ON co.group_id = gm.group_id
      WHERE c.id = ?
        AND gm.user_id = ?
      `,
      [comicId, req.session.userId],
    );

    if (comics.length === 0) {
      return res.status(404).send("漫画が見つかりません");
    }

    // 所持巻一覧取得
    const [volumes] = await connection.promise().query(
      `
      SELECT
          co.id AS owning_id,
          cv.volume,
          cv.image_url,
          co.price,
          ug.group_name
      FROM comic_volumes cv
      JOIN comic_owning co
        ON cv.comic_id = co.comic_id
       AND cv.volume = co.volume
      JOIN user_groups ug
        ON co.group_id = ug.id
      JOIN group_members gm
        ON ug.id = gm.group_id
      WHERE cv.comic_id = ?
        AND gm.user_id = ?
      ORDER BY cv.volume ASC
      `,
      [comicId, req.session.userId],
    );

    // デフォルト画像設定
    const defaultImage = "https://via.placeholder.com/150x200?text=No+Image";

    for (const volume of volumes) {
      const imageUrlValue =
        typeof volume.image_url === "string" ? volume.image_url : "";

      if (imageUrlValue.trim() === "") {
        const resolvedImageUrl = await ensureVolumeImageUrl(
          comicId,
          comics[0].comic_name,
          volume.volume,
        );
        volume.image_url = resolvedImageUrl || "";
      }
    }

    const volumesWithImage = volumes.map((volume) => {
      const imageUrlValue =
        typeof volume.image_url === "string" ? volume.image_url.trim() : "";
      const normalizedPrice =
        typeof volume.price === "number"
          ? volume.price
          : Number(volume.price) || 0;

      return {
        ...volume,
        image_url: imageUrlValue !== "" ? imageUrlValue : defaultImage,
        price: normalizedPrice,
        group_name: volume.group_name || "未設定",
      };
    });

    res.render("detail.ejs", {
      comic: comics[0],
      volumes: volumesWithImage,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("エラーが発生しました");
  }
});

app.get("/add", (req, res) => {
  if (req.session.userId === undefined) {
    return res.redirect("/login");
  }

  const presetComicName = req.query.comic_name || "";
  const presetComicId = req.query.comic_id || "";
  const presetGroupId = req.query.group_id || "";
  const presetError = req.query.error || "";

  connection.query(
    `SELECT user_groups.id, user_groups.group_name
     FROM user_groups
     JOIN group_members
       ON user_groups.id = group_members.group_id
     WHERE group_members.user_id = ?`,
    [req.session.userId],
    (err, groups) => {
      if (err) {
        console.error(err);
        return res.send(err);
      }

      res.render("add.ejs", {
        username: req.session.username,
        error: presetError,
        groups: groups,
        comicName: presetComicName,
        comicId: presetComicId,
        selectedGroupId: presetGroupId,
      });
    },
  );
});

app.post("/add", async (req, res) => {
  if (req.session.userId === undefined) {
    return res.redirect("/login");
  }

  const comicName = req.body.comic_name;
  const volume = Number(req.body.volume) || 1;
  const volumeStart = Number(req.body.volume_start) || 0;
  const volumeEnd = Number(req.body.volume_end) || 0;
  const price = Number(req.body.price) || 0;
  const groupId = req.body.group_id;
  const redirectComicId = Number(req.body.comic_id);

  try {
    let comicId;
    let bookInfo = {
      author: "",
      publisher: "",
      imageUrl: "",
      isbn: "",
    };

    const [comicResults] = await connection
      .promise()
      .query("SELECT id FROM comics WHERE comic_name = ?", [comicName]);

    if (comicResults.length > 0) {
      comicId = comicResults[0].id;
    } else {
      bookInfo = await fetchBookFromGoogle(comicName, volume);

      const [insertComic] = await connection.promise().query(
        `INSERT INTO comics (comic_name, latest_volume, author, publisher)
         VALUES (?, ?, ?, ?)`,
        [comicName, volume, bookInfo.author, bookInfo.publisher],
      );

      comicId = insertComic.insertId;
    }

    const volumesToAdd = [];
    if (volumeStart > 0 && volumeEnd > 0 && volumeEnd >= volumeStart) {
      for (let current = volumeStart; current <= volumeEnd; current += 1) {
        volumesToAdd.push(current);
      }
    } else {
      volumesToAdd.push(volume);
    }

    for (const currentVolume of volumesToAdd) {
      const [volumeResults] = await connection
        .promise()
        .query(
          `SELECT id, image_url FROM comic_volumes WHERE comic_id = ? AND volume = ?`,
          [comicId, currentVolume],
        );

      if (volumeResults.length === 0) {
        bookInfo = await fetchBookFromGoogle(comicName, currentVolume);

        await connection.promise().query(
          `INSERT INTO comic_volumes (comic_id, volume, image_url)
           VALUES (?, ?, ?)`,
          [comicId, currentVolume, bookInfo.imageUrl],
        );
      } else if (
        !volumeResults[0].image_url ||
        volumeResults[0].image_url.trim() === ""
      ) {
        bookInfo = await fetchBookFromGoogle(comicName, currentVolume);

        if (bookInfo.imageUrl) {
          await connection
            .promise()
            .query(`UPDATE comic_volumes SET image_url = ? WHERE id = ?`, [
              bookInfo.imageUrl,
              volumeResults[0].id,
            ]);
        }
      }

      const [owningResults] = await connection
        .promise()
        .query(
          `SELECT id FROM comic_owning WHERE group_id = ? AND comic_id = ? AND volume = ?`,
          [groupId, comicId, currentVolume],
        );

      if (owningResults.length > 0) {
        const errorMessage = `同じグループに同じ漫画の${currentVolume}巻が既に登録されています。`;
        const query = new URLSearchParams({
          comic_name: comicName || "",
          comic_id:
            Number.isInteger(redirectComicId) && redirectComicId > 0
              ? String(redirectComicId)
              : "",
          group_id: groupId || "",
          error: errorMessage,
        }).toString();

        return res.redirect(`/add?${query}`);
      }

      await connection.promise().query(
        `INSERT INTO comic_owning (group_id, comic_id, volume, price)
         VALUES (?, ?, ?, ?)`,
        [groupId, comicId, currentVolume, price],
      );
    }

    const [groupMembers] = await connection
      .promise()
      .query(`SELECT user_id FROM group_members WHERE group_id = ?`, [groupId]);
    const [groupRows] = await connection
      .promise()
      .query(`SELECT group_name FROM user_groups WHERE id = ?`, [groupId]);
    const groupNameText = groupRows[0]?.group_name || "指定グループ";

    const summaryText =
      volumesToAdd.length > 1
        ? `${volumesToAdd[0]}〜${volumesToAdd[volumesToAdd.length - 1]}巻`
        : `${volumesToAdd[0]}巻`;

    await Promise.all(
      groupMembers.map((member) =>
        createNotification(
          member.user_id,
          `グループ「${groupNameText}」に新しい漫画「${comicName}」の${summaryText}が追加されました。`,
        ),
      ),
    );

    if (Number.isInteger(redirectComicId) && redirectComicId > 0) {
      return res.redirect(`/comics/${redirectComicId}`);
    }

    res.redirect("/list");
  } catch (err) {
    console.error("データベースまたは処理エラー:", err);
    const query = new URLSearchParams({
      comic_name: comicName || "",
      comic_id:
        Number.isInteger(Number(req.body.comic_id)) &&
        Number(req.body.comic_id) > 0
          ? String(Number(req.body.comic_id))
          : "",
      group_id: groupId || "",
      error: `登録中にエラーが発生しました: ${err.message}`,
    }).toString();
    return res.redirect(`/add?${query}`);
  }
});

app.post("/delete-volume", async (req, res) => {
  if (req.session.userId === undefined) {
    return res.redirect("/login");
  }

  const comicId = Number(req.body.comic_id);
  const volume = Number(req.body.volume);

  if (Number.isNaN(comicId) || Number.isNaN(volume)) {
    return res.status(400).send("不正な削除リクエストです");
  }

  try {
    const [owningRows] = await connection
      .promise()
      .query(`SELECT id FROM comic_owning WHERE comic_id = ? AND volume = ?`, [
        comicId,
        volume,
      ]);

    if (owningRows.length === 0) {
      return res.status(404).send("削除対象が見つかりません");
    }

    const owningId = owningRows[0].id;

    await connection
      .promise()
      .query(`DELETE FROM comic_owning WHERE id = ?`, [owningId]);

    res.redirect(`/comics/${comicId}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("巻の削除に失敗しました");
  }
});

app.get("/lend/:owningId", async (req, res) => {
  if (req.session.userId === undefined) {
    return res.redirect("/login");
  }

  const owningId = Number(req.params.owningId);

  if (Number.isNaN(owningId)) {
    return res.status(400).send("不正な所有情報です");
  }

  try {
    const [owningRows] = await connection.promise().query(
      `SELECT co.id, co.group_id, co.comic_id, co.volume, co.price, c.comic_name
       FROM comic_owning co
       JOIN comics c ON co.comic_id = c.id
       WHERE co.id = ?`,
      [owningId],
    );

    if (owningRows.length === 0) {
      return res.status(404).send("貸し出し対象が見つかりません");
    }

    const owning = owningRows[0];

    res.render("lending.ejs", {
      username: req.session.username,
      owning,
      error: null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("貸し出し画面の読み込みに失敗しました");
  }
});

app.post("/lend/:owningId", async (req, res) => {
  if (req.session.userId === undefined) {
    return res.redirect("/login");
  }

  const owningId = Number(req.params.owningId);
  const borrowerEmail = (req.body.borrower_email || "").trim();
  const dueDays = Number(req.body.due_days || 7);

  if (Number.isNaN(owningId)) {
    return res.status(400).send("不正な所有情報です");
  }

  if (!borrowerEmail) {
    return res.status(400).send("借り手のメールアドレスを入力してください");
  }

  if (!Number.isFinite(dueDays) || dueDays <= 0) {
    return res.status(400).send("返却日数は1以上で指定してください");
  }

  try {
    const [userRows] = await connection
      .promise()
      .query(`SELECT id, username FROM users WHERE email = ?`, [borrowerEmail]);

    if (userRows.length === 0) {
      const [owningRows] = await connection.promise().query(
        `SELECT co.id, co.group_id, co.comic_id, co.volume, co.price, c.comic_name
         FROM comic_owning co
         JOIN comics c ON co.comic_id = c.id
         WHERE co.id = ?`,
        [owningId],
      );

      return res.render("lending.ejs", {
        username: req.session.username,
        owning: owningRows[0],
        error: "指定されたメールアドレスのユーザーが見つかりません",
      });
    }

    const borrowerId = userRows[0].id;
    const borrowerName = userRows[0].username || borrowerEmail;
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + dueDays);

    const [activeLendingRows] = await connection
      .promise()
      .query(
        `SELECT id FROM lending WHERE owning_id = ? AND status = 'lending'`,
        [owningId],
      );

    if (activeLendingRows.length > 0) {
      const [owningRows] = await connection.promise().query(
        `SELECT co.id, co.group_id, co.comic_id, co.volume, co.price, c.comic_name
         FROM comic_owning co
         JOIN comics c ON co.comic_id = c.id
         WHERE co.id = ?`,
        [owningId],
      );

      return res.render("lending.ejs", {
        username: req.session.username,
        owning: owningRows[0],
        error: "この漫画はすでに貸し出し中です。",
      });
    }

    const [owningRowsForNotification] = await connection.promise().query(
      `SELECT c.comic_name
       FROM comic_owning co
       JOIN comics c ON co.comic_id = c.id
       WHERE co.id = ?`,
      [owningId],
    );

    const comicName = owningRowsForNotification[0]?.comic_name || "漫画";

    await connection.promise().query(
      `INSERT INTO lending (owning_id, borrower_id, lender_id, due, status)
       VALUES (?, ?, ?, ?, 'lending')`,
      [
        owningId,
        borrowerId,
        req.session.userId,
        dueDate.toISOString().slice(0, 10),
      ],
    );

    await createNotification(
      borrowerId,
      `${borrowerName}さんが「${comicName}」を借り受けました。返却期限は ${dueDate.toISOString().slice(0, 10)} です。`,
    );
    await createNotification(
      req.session.userId,
      `${borrowerName}さんに「${comicName}」を貸し出しました。返却期限は ${dueDate.toISOString().slice(0, 10)} です。`,
    );

    res.redirect(`/comics/${req.body.comic_id}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("貸し出し登録に失敗しました");
  }
});

app.get("/create_group", (req, res) => {
  if (req.session.userId === undefined) {
    return res.redirect("/login");
  }
  res.render("create_group.ejs", { error: null });
});

app.post("/create_group", (req, res) => {
  if (req.session.userId === undefined) {
    return res.redirect("/login");
  }

  const groupName = req.body.group_name;
  const emails = Array.isArray(req.body.emails)
    ? req.body.emails
    : req.body.emails
      ? [req.body.emails]
      : [];
  connection.query(
    "select email from users where id = ?",
    [req.session.userId],
    (err, results) => {
      if (err) {
        console.error(err);
        return res.send(err);
      }
      emails.push(results[0].email);
    },
  );

  console.log(req.body);
  console.log(emails);

  connection.query(
    "INSERT INTO user_groups (group_name, owner_id) VALUES (?, ?)",
    [groupName, req.session.userId],
    (err, results) => {
      if (err) {
        console.error(err);
        return res.send(err);
      }

      const groupId = results.insertId;

      emails.forEach((email) => {
        connection.query(
          "SELECT id FROM users WHERE email = ?",
          [email],
          (err, results) => {
            if (err) {
              console.error(err);
              return res.send(err);
            }

            if (results.length > 0) {
              const userId = results[0].id;
              connection.query(
                "INSERT INTO group_members (group_id, user_id) VALUES (?, ?)",
                [groupId, userId],
                async (err) => {
                  if (err) {
                    console.error(err);
                    return res.send(err);
                  }

                  await createNotification(
                    userId,
                    `新しいグループ「${groupName}」に追加されました。`,
                  );
                },
              );
            }
          },
        );
      });
      res.redirect("/home");
    },
  );
});

app.get("/show_groups", (req, res) => {
  if (req.session.userId === undefined) {
    return res.redirect("/login");
  }

  connection.query(
    `SELECT user_groups.id, user_groups.group_name
     FROM user_groups
     JOIN group_members ON user_groups.id = group_members.group_id
     WHERE group_members.user_id = ?
     ORDER BY user_groups.group_name ASC`,
    [req.session.userId],
    (err, results) => {
      if (err) {
        console.error(err);
        return res.send(err);
      }

      res.render("show_groups.ejs", {
        error: null,
        groups: results,
        username: req.session.username,
      });
    },
  );
});

app.get("/groups/:groupId", async (req, res) => {
  if (req.session.userId === undefined) {
    return res.redirect("/login");
  }

  const groupId = Number(req.params.groupId);

  if (Number.isNaN(groupId)) {
    return res.status(400).send("不正なグループIDです");
  }

  try {
    const [membershipRows] = await connection
      .promise()
      .query("SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?", [
        groupId,
        req.session.userId,
      ]);

    if (membershipRows.length === 0) {
      return res.status(403).send("このグループのメンバーではありません");
    }

    const [groupRows] = await connection
      .promise()
      .query("SELECT id, group_name, owner_id FROM user_groups WHERE id = ?", [
        groupId,
      ]);

    if (groupRows.length === 0) {
      return res.status(404).send("グループが見つかりません");
    }

    const [memberRows] = await connection.promise().query(
      `SELECT users.id, users.username, users.email
       FROM group_members
       JOIN users ON group_members.user_id = users.id
       WHERE group_members.group_id = ?
       ORDER BY users.username ASC`,
      [groupId],
    );

    res.render("group_detail.ejs", {
      error: req.query.error || "",
      success: req.query.success || "",
      group: groupRows[0],
      members: memberRows,
      isHost: groupRows[0].owner_id === req.session.userId,
      username: req.session.username,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("グループ詳細の読み込みに失敗しました");
  }
});

app.post("/groups/:groupId/add_member", async (req, res) => {
  if (req.session.userId === undefined) {
    return res.redirect("/login");
  }

  const groupId = Number(req.params.groupId);
  const email = (req.body.email || "").trim().toLowerCase();

  if (Number.isNaN(groupId) || !email) {
    const params = new URLSearchParams({
      error: "メールアドレスを入力してください",
    }).toString();
    return res.redirect(`/groups/${groupId}?${params}`);
  }

  try {
    const [membershipRows] = await connection
      .promise()
      .query("SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?", [
        groupId,
        req.session.userId,
      ]);

    if (membershipRows.length === 0) {
      const params = new URLSearchParams({
        error: "このグループのメンバーではありません",
      }).toString();
      return res.redirect(`/groups/${groupId}?${params}`);
    }

    const [userRows] = await connection
      .promise()
      .query("SELECT id, username FROM users WHERE LOWER(email) = ?", [email]);

    if (userRows.length === 0) {
      const params = new URLSearchParams({
        error: "そのメールアドレスのユーザーは見つかりませんでした",
      }).toString();
      return res.redirect(`/groups/${groupId}?${params}`);
    }

    const targetUserId = userRows[0].id;
    const [existingRows] = await connection
      .promise()
      .query("SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?", [
        groupId,
        targetUserId,
      ]);

    if (existingRows.length > 0) {
      const params = new URLSearchParams({
        error: "そのユーザーはすでにメンバーです",
      }).toString();
      return res.redirect(`/groups/${groupId}?${params}`);
    }

    await connection
      .promise()
      .query("INSERT INTO group_members (group_id, user_id) VALUES (?, ?)", [
        groupId,
        targetUserId,
      ]);

    const params = new URLSearchParams({
      success: `${userRows[0].username}さんを追加しました`,
    }).toString();
    return res.redirect(`/groups/${groupId}?${params}`);
  } catch (err) {
    console.error(err);
    const params = new URLSearchParams({
      error: "ユーザー追加に失敗しました",
    }).toString();
    return res.redirect(`/groups/${groupId}?${params}`);
  }
});

app.post("/groups/:groupId/remove_member/:userId", async (req, res) => {
  if (req.session.userId === undefined) {
    return res.redirect("/login");
  }

  const groupId = Number(req.params.groupId);
  const targetUserId = Number(req.params.userId);

  if (Number.isNaN(groupId) || Number.isNaN(targetUserId)) {
    const params = new URLSearchParams({
      error: "不正なリクエストです",
    }).toString();
    return res.redirect(`/groups/${groupId}?${params}`);
  }

  try {
    const [groupRows] = await connection
      .promise()
      .query("SELECT owner_id FROM user_groups WHERE id = ?", [groupId]);

    if (groupRows.length === 0) {
      const params = new URLSearchParams({
        error: "グループが見つかりません",
      }).toString();
      return res.redirect(`/groups/${groupId}?${params}`);
    }

    if (groupRows[0].owner_id !== req.session.userId) {
      const params = new URLSearchParams({
        error: "ホストのみメンバーを削除できます",
      }).toString();
      return res.redirect(`/groups/${groupId}?${params}`);
    }

    if (targetUserId === groupRows[0].owner_id) {
      const params = new URLSearchParams({
        error: "ホスト自身は削除できません",
      }).toString();
      return res.redirect(`/groups/${groupId}?${params}`);
    }

    await connection
      .promise()
      .query("DELETE FROM group_members WHERE group_id = ? AND user_id = ?", [
        groupId,
        targetUserId,
      ]);

    const params = new URLSearchParams({
      success: "メンバーを削除しました",
    }).toString();
    return res.redirect(`/groups/${groupId}?${params}`);
  } catch (err) {
    console.error(err);
    const params = new URLSearchParams({
      error: "メンバー削除に失敗しました",
    }).toString();
    return res.redirect(`/groups/${groupId}?${params}`);
  }
});

app.get("/chat", (req, res) => {
  if (req.session.userId === undefined) {
    return res.redirect("/login");
  }
  connection.query(
    "SELECT user_groups.id, user_groups.group_name FROM user_groups JOIN group_members ON user_groups.id = group_members.group_id WHERE group_members.user_id = ?",
    [req.session.userId],
    (err, results) => {
      if (err) {
        console.error(err);
        return res.send(err);
      }
      res.render("chat_list.ejs", { error: null, groups: results });
    },
  );
});

app.get("/chat_list", (req, res) => {
  return res.redirect("/chat");
});

app.get("/chat/:groupId", (req, res) => {
  if (req.session.userId === undefined) {
    return res.redirect("/login");
  }
  const groupId = req.params.groupId;
  connection.query(
    "SELECT group_chat.message, group_chat.created_at, group_chat.sender_id, users.username FROM group_chat JOIN users ON group_chat.sender_id = users.id WHERE group_chat.group_id = ? ORDER BY group_chat.created_at ASC",
    [groupId],
    (err, results) => {
      if (err) {
        console.error(err);
        return res.send(err);
      }
      connection.query(
        "SELECT group_name FROM user_groups WHERE id = ?",
        [groupId],
        (err, groupResults) => {
          if (err) {
            console.error(err);
            return res.send(err);
          }
          res.render("chat.ejs", {
            error: null,
            messages: results,
            groupId: groupId,
            groupName: groupResults[0].group_name,
            currentUserId: req.session.userId,
          });
        },
      );
    },
  );
});

app.post("/chat/:groupId", (req, res) => {
  if (req.session.userId === undefined) {
    return res.redirect("/login");
  }
  const groupId = req.params.groupId;
  const message = req.body.message;
  connection.query(
    "INSERT INTO group_chat (group_id, sender_id, message) VALUES (?, ?, ?)",
    [groupId, req.session.userId, message],
    (err) => {
      if (err) {
        console.error(err);
        return res.send(err);
      }
      res.redirect(`/chat/${groupId}`);
    },
  );
});

app.listen(3000, () => {
  console.log("Server started on http://localhost:3000");
});
