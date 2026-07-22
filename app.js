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

connection.connect((err) => {
  if (err) {
    console.error("MySQL接続エラー:", err);
    return;
  }
  console.log("MySQLに接続しました");
});

console.log("HOST:", process.env.DB_HOST);
console.log("PORT:", process.env.DB_PORT);
console.log("USER:", process.env.DB_USER);
console.log("DB:", process.env.DB_NAME);

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

app.post("/login", (req, res) => {
  const email = req.body.email;
  connection.query(
    "SELECT * FROM users WHERE email = ?",
    [email],
    (err, results) => {
      if (err) {
        console.error(err);
        return res.send(err);
      }
      if (results.length > 0) {
        const plain = req.body.password;
        const hash = results[0].password;
        bcrypt.compare(plain, hash, (err, isEqual) => {
          if (isEqual) {
            req.session.userId = results[0].id;
            req.session.username = results[0].username;
            res.redirect("/home");
          } else {
            res.send("パスワードが違います");
          }
        });
      } else {
        res.send("メールアドレスが見つかりません");
      }
    },
  );
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

app.get("/home", (req, res) => {
  if (req.session.userId === undefined) {
    res.redirect("/login");
  } else {
    res.render("home.ejs");
  }
});

app.get("/list", (req, res) => {
  if (req.session.userId === undefined) {
    return res.redirect("/login");
  }

  const groupId = req.query.group_id || "";
  const search = req.query.search || "";

  // グループ一覧を取得
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

      // 漫画一覧取得用SQL
      let sql = `
        SELECT DISTINCT comics.id, comics.comic_name
        FROM comics
        JOIN comic_owning
          ON comics.id = comic_owning.comic_id
        JOIN group_members
          ON comic_owning.group_id = group_members.group_id
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

      connection.query(sql, params, (err, comics) => {
        if (err) {
          console.error(err);
          return res.send(err);
        }

        res.render("list.ejs", {
          comics: comics,
          groups: groups,
          selectedGroupId: groupId,
          search: search,
        });
      });
    },
  );
});

app.get("/add", (req, res) => {
  if (req.session.userId === undefined) {
    return res.redirect("/login");
  }

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
        error: null,
        groups: groups,
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
  const price = Number(req.body.price) || 0;
  const groupId = req.body.group_id;

  // MySQL2のpromiseインスタンスを取得
  const db = connection.promise();

  try {
    // トランザクション開始
    await db.beginTransaction();

    let comicId;

    // 1. comicsに存在するか確認
    const [comicResults] = await db.query(
      "SELECT id FROM comics WHERE comic_name = ?",
      [comicName],
    );

    if (comicResults.length > 0) {
      comicId = comicResults[0].id;
    } else {
      // 新規漫画の場合：API検索（巻数も含めて検索精度を向上）
      let author = "";
      let publisher = "";

      try {
        const response = await axios.get(
          "https://app.rakuten.co.jp/services/api/BooksBook/Search/20170404",
          {
            params: {
              applicationId: process.env.RAKUTEN_APP_ID,
              title: `${comicName} ${volume}巻`,
            },
            timeout: 3000, // 3秒でタイムアウト設定
          },
        );

        if (response.data.Items && response.data.Items.length > 0) {
          const book = response.data.Items[0].Item;
          author = book.author || "";
          publisher = book.publisherName || "";
        }
      } catch (apiErr) {
        console.warn("楽天API取得失敗（comics新規作成時）:", apiErr.message);
        // APIが失敗してもDB登録は続行する
      }

      // comics追加
      const [insertComic] = await db.query(
        `INSERT INTO comics (comic_name, latest_volume, author, publisher)
         VALUES (?, ?, ?, ?)`,
        [comicName, volume, author, publisher],
      );

      comicId = insertComic.insertId;
    }

    // 2. 巻情報（comic_volumes）が存在するか確認
    const [volumeResults] = await db.query(
      `SELECT id FROM comic_volumes WHERE comic_id = ? AND volume = ?`,
      [comicId, volume],
    );

    // 巻情報がない場合のみ追加
    if (volumeResults.length === 0) {
      let isbn = "";
      let imageUrl = "";

      try {
        const response = await axios.get(
          "https://app.rakuten.co.jp/services/api/BooksBook/Search/20170404",
          {
            params: {
              applicationId: process.env.RAKUTEN_APP_ID,
              title: `${comicName} ${volume}巻`,
            },
            timeout: 3000,
          },
        );

        if (response.data.Items && response.data.Items.length > 0) {
          const book = response.data.Items[0].Item;
          isbn = book.isbn || "";
          imageUrl = book.largeImageUrl || "";
        }
      } catch (apiErr) {
        console.warn("楽天API取得失敗（volume追加時）:", apiErr.message);
      }

      await db.query(
        `INSERT INTO comic_volumes (comic_id, volume, isbn, image_url)
         VALUES (?, ?, ?, ?)`,
        [comicId, volume, isbn, imageUrl],
      );
    }

    // 3. 所持情報の重複確認
    const [owningResults] = await db.query(
      `SELECT id FROM comic_owning
       WHERE group_id = ? AND comic_id = ? AND volume = ?`,
      [groupId, comicId, volume],
    );

    if (owningResults.length > 0) {
      // 重複時はロールバックしてフォームに戻す
      await db.rollback();

      const [groups] = await db.query(
        `SELECT user_groups.id, user_groups.group_name
         FROM user_groups
         JOIN group_members ON user_groups.id = group_members.group_id
         WHERE group_members.user_id = ?`,
        [req.session.userId],
      );

      return res.render("add.ejs", {
        username: req.session.username,
        error: "同じグループに同じ漫画の同じ巻が既に登録されています。",
        groups: groups,
      });
    }

    // 4. 所持情報追加
    await db.query(
      `INSERT INTO comic_owning (group_id, comic_id, volume, price)
       VALUES (?, ?, ?, ?)`,
      [groupId, comicId, volume, price],
    );

    // すべての処理が成功したらコミット
    await db.commit();
    res.redirect("/list");
  } catch (err) {
    // エラー発生時はロールバック
    await db.rollback();
    console.error("登録処理エラー:", err);

    // ユーザーには詳細なスタックトレースを見せない
    res
      .status(500)
      .send("サーバーエラーが発生しました。時間をおいて再度お試しください。");
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
                (err) => {
                  if (err) {
                    console.error(err);
                    return res.send(err);
                  }
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
    "SELECT user_groups.group_name from user_groups JOIN group_members ON user_groups.id = group_members.group_id WHERE group_members.user_id = ?",
    [req.session.userId],
    (err, results) => {
      res.render("show_groups.ejs", { error: null, groups: results });
    },
  );
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

app.get("/chat/:groupId", (req, res) => {
  if (req.session.userId === undefined) {
    return res.redirect("/login");
  }
  const groupId = req.params.groupId;
  connection.query(
    "SELECT group_chat.message, group_chat.created_at, users.username FROM group_chat JOIN users ON group_chat.sender_id = users.id WHERE group_chat.group_id = ? ORDER BY group_chat.created_at ASC",
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
