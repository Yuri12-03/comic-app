const express = require("express");
const path = require("path");
const app = express();
const mysql = require("mysql2");
const session = require("express-session");
const bcrypt = require("bcrypt");

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

const connection = mysql.createConnection({
  host: "localhost",
  user: "YURI",
  password: "Ageha4/26",
  database: "comicapp",
});

connection.connect((err) => {
  if (err) {
    console.error("MySQL接続エラー:", err);
    return;
  }
  console.log("MySQLに接続しました");
});

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
    connection.query(
      "INSERT INTO users (username, email, password) VALUES (?, ?, ?)",
      [username, email, hash],
      (err, results) => {
        if (err) {
          console.error(err);
          return res.send(err);
        } else {
          req.session.userId = results.insertId;
          req.session.username = username;
          res.redirect("/home");
        }
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

  connection.query(
    `SELECT comic_name
     FROM comics
     JOIN comic_owning
       ON comics.id = comic_owning.comic_id
     WHERE comic_owning.group_id = ?`,
    [req.session.userId],
    (err, comics) => {
      if (err) {
        console.error(err);
        return res.send(err);
      }

      connection.query(
        `SELECT user_groups.group_name, user_groups.id
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

          res.render("list.ejs", {
            comics: comics,
            groups: groups,
            selectedGroupId: req.query.group_id || "",
          });
        },
      );
    },
  );
});

app.get("/add", (req, res) => {
  if (req.session.userId === undefined) {
    return res.redirect("/login");
  }
  res.render("add.ejs", { error: null });
});

app.post("/add", (req, res) => {
  if (req.session.userId === undefined) {
    return res.redirect("/login");
  }

  const comicName = req.body.comic_name;
  const latest_volume = 1;
  const author = req.body.author || "";
  const publisher = req.body.publisher || "";

  const price = req.body.price || 0;
  const volume = req.body.volume || 1;

  connection.query(
    "INSERT INTO comics (comic_name, latest_volume, author, publisher) VALUES (?, ?, ?, ?)",
    [comicName, latest_volume, author, publisher],
    (err, results) => {
      if (err) {
        console.error(err);
        return res.send(err);
      }

      const comicId = results.insertId;

      connection.query(
        "INSERT INTO comic_owning (group_id, comic_id, volume, price) VALUES (?, ?, ?, ?)",
        [req.session.userId, comicId, volume, price],
        (err) => {
          if (err) {
            console.error(err);
            return res.send(err);
          }

          res.redirect("/list");
        },
      );
    },
  );
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

app.listen(3000, () => {
  console.log("Server started on http://localhost:3000");
});
