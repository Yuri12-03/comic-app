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
  try {
    const response = await axios.get(
      "https://www.googleapis.com/books/v1/volumes",
      {
        params: {
          q: `intitle:${comicName} ${volume} -小説 -ノベライズ -ファンブック`,
          maxResults: 10,
          langRestrict: "ja",
          key: process.env.GOOGLE_BOOKS_API_KEY,
        },
        timeout: 5000,
      },
    );

    const items = response.data.items || [];

    if (items.length === 0) {
      return {
        author: "",
        publisher: "",
        imageUrl: "",
        isbn: "",
      };
    }

    // タイトルが一番一致するものを探す
    let target = items.find((item) => {
      const title = item.volumeInfo.title || "";

      return (
        title.includes(comicName) &&
        (title.includes(`${volume}`) ||
          title.includes(`${volume}巻`) ||
          title.includes(`第${volume}巻`))
      );
    });

    // 見つからなければ漫画名だけ一致するもの
    if (!target) {
      target = items.find((item) => {
        const title = item.volumeInfo.title || "";
        return title.includes(comicName);
      });
    }

    // それでも無ければ先頭
    if (!target) {
      target = items[0];
    }

    const book = target.volumeInfo;

    let imageUrl = "";
    let isbn = "";

    if (book.imageLinks) {
      imageUrl =
        book.imageLinks.thumbnail || book.imageLinks.smallThumbnail || "";

      imageUrl = imageUrl.replace("http://", "https://");
    }

    if (book.industryIdentifiers) {
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
    console.warn("Google Books APIエラー:", error.message);

    return {
      author: "",
      publisher: "",
      imageUrl: "",
      isbn: "",
    };
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

      connection.query(sql, params, (err, comics) => {
        if (err) {
          console.error(err);
          return res.send(err);
        }

        // デフォルト画像の表示設定
        const defaultImage =
          "https://via.placeholder.com/150x200?text=No+Image";

        // 各コミックの image_url が空（nullまたは""）の場合、デフォルト画像に差し替える
        const comicsWithImage = comics.map((comic) => {
          return {
            ...comic,
            image_url:
              comic.image_url && comic.image_url.trim() !== ""
                ? comic.image_url
                : defaultImage,
          };
        });

        res.render("list.ejs", {
          comics: comicsWithImage,
          groups: groups,
          selectedGroupId: groupId,
          search: search,
        });
      });
    },
  );
});

// 例: 各漫画の巻一覧ページ (/comics/:id)
app.get("/comics/:id", async (req, res) => {
  if (req.session.userId === undefined) {
    return res.redirect("/login");
  }

  const comicId = req.params.id;

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
          cv.volume,
          cv.image_url,
          cv.isbn,
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

    const volumesWithImage = volumes.map((volume) => ({
      ...volume,
      image_url:
        volume.image_url && volume.image_url.trim() !== ""
          ? volume.image_url
          : defaultImage,
    }));

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

  try {
    let comicId;

    // 1. comicsテーブル確認
    const [comicResults] = await connection
      .promise()
      .query("SELECT id FROM comics WHERE comic_name = ?", [comicName]);

    if (comicResults.length > 0) {
      comicId = comicResults[0].id;
    } else {
      // 2. 新規漫画登録（APIから取得）
      const bookInfo = await fetchBookFromGoogle(comicName, volume);

      const [insertComic] = await connection.promise().query(
        `INSERT INTO comics (comic_name, latest_volume, author, publisher)
         VALUES (?, ?, ?, ?)`,
        [comicName, volume, bookInfo.author, bookInfo.publisher],
      );

      comicId = insertComic.insertId;

      await connection.promise().query(
        `INSERT INTO comic_volumes (comic_id, volume, image_url)
         VALUES (?, ?, ?)`,
        [comicId, volume, bookInfo.imageUrl],
      );
    }

    // 3. 巻情報確認
    const [volumeResults] = await connection
      .promise()
      .query(`SELECT id FROM comic_volumes WHERE comic_id = ? AND volume = ?`, [
        comicId,
        volume,
      ]);

    if (volumeResults.length === 0) {
      const bookInfo = await fetchBookFromGoogle(comicName, volume);

      await connection.promise().query(
        `INSERT INTO comic_volumes (comic_id, volume, image_url)
         VALUES (?, ?, ?)`,
        [comicId, volume, bookInfo.imageUrl],
      );
    }

    // 4. 所持情報重複確認
    const [owningResults] = await connection
      .promise()
      .query(
        `SELECT id FROM comic_owning WHERE group_id = ? AND comic_id = ? AND volume = ?`,
        [groupId, comicId, volume],
      );

    if (owningResults.length > 0) {
      const [groups] = await connection.promise().query(
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

    // 5. 所持情報追加
    await connection.promise().query(
      `INSERT INTO comic_owning (group_id, comic_id, volume, price)
       VALUES (?, ?, ?, ?)`,
      [groupId, comicId, volume, price],
    );

    res.redirect("/list");
  } catch (err) {
    console.error("データベースまたは処理エラー:", err);
    return res.status(500).send("エラーが発生しました: " + err.message);
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
