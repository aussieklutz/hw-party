/*
 * Hedgewars, a free turn based strategy game
 * Copyright (c) 2004-2015 Andrey Korotaev <unC0Rr@gmail.com>
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; version 2 of the License
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301  USA
 */

#include "partyclient.h"

#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QNetworkCookie>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QSslError>
#include <QSslSocket>
#include <QTextStream>
#include <QTimer>

#include "hwconsts.h"

PartyClient::PartyClient(QObject *parent) : QObject(parent), m_ws() {
  connect(&m_ws, &QWebSocket::disconnected, this, [this] {
    dumpDiag(QStringLiteral("ws disconnected"),
             QStringLiteral("error=%1 state=%2 closeCode=%3")
                 .arg(m_ws.errorString())
                 .arg(m_ws.state())
                 .arg(m_ws.closeCode()));
    Q_EMIT disconnected(m_ws.errorString());
    // unexpected drop while a room is open: reconnect with backoff so a
    // long-lived host socket survives idle closes; the DO replays state and
    // registrations on rejoin
    if (m_closing || m_room.isEmpty()) return;
    const int delay = m_backoffMs;
    m_backoffMs = qMin(m_backoffMs * 2, 10000);
    dumpDiag(QStringLiteral("reconnect scheduled"),
             QStringLiteral("room=%1 delay=%2ms").arg(m_room).arg(delay));
    QTimer::singleShot(delay, this, [this] {
      if (!m_closing && !m_room.isEmpty()) connectWs();
    });
  });
  connect(&m_ws, &QWebSocket::textMessageReceived, this,
          &PartyClient::handleMessage);
  auto onWsError = [this](QAbstractSocket::SocketError err) {
    dumpDiag(QStringLiteral("ws error"), QStringLiteral("%1 (%2) state=%3")
                                             .arg(m_ws.errorString())
                                             .arg(err)
                                             .arg(m_ws.state()));
  };
  // errorOccurred() replaced the overloaded error() signal in Qt 6.5
#if QT_VERSION >= QT_VERSION_CHECK(6, 5, 0)
  connect(&m_ws, &QWebSocket::errorOccurred, this, onWsError);
#else
  connect(&m_ws,
          QOverload<QAbstractSocket::SocketError>::of(&QWebSocket::error), this,
          onWsError);
#endif
#if QT_CONFIG(ssl)
  connect(
      &m_ws, &QWebSocket::sslErrors, this,
      [this](const QList<QSslError> &errors) {
        QString detail = QStringLiteral("count=%1").arg(errors.size());
        for (const QSslError &e : errors) {
          detail += QStringLiteral("\n  %1").arg(e.errorString());
          const QSslCertificate cert = e.certificate();
          if (!cert.isNull())
            detail +=
                QStringLiteral("\n  cert: %1 (%2) issuer=%3")
                    .arg(
                        cert.subjectInfo(QSslCertificate::CommonName).join(','))
                    .arg(cert.effectiveDate().toString())
                    .arg(
                        cert.issuerInfo(QSslCertificate::CommonName).join(','));
        }
        dumpDiag(QStringLiteral("ws ssl errors"), detail);
      });
#endif
  m_nam = new QNetworkAccessManager(this);
}

void PartyClient::dumpDiag(const QString &event, const QString &detail) {
  // Diagnostics for the party connection, notably TLS problems: on Windows
  // the Qt MinGW build needs its TLS backend deployed, and a failed
  // handshake used to surface only as a bare error dialog. Appends to
  // <cfgdir>/Logs/party-client.log so a bug report can include it.
  QDir dir(cfgdir.absolutePath() + QStringLiteral("/Logs"));
  if (!dir.exists()) QDir().mkpath(dir.absolutePath());
  QFile log(dir.filePath(QStringLiteral("party-client.log")));
  if (!log.open(QIODevice::WriteOnly | QIODevice::Append | QIODevice::Text))
    return;
  QTextStream stream(&log);
  stream << QDateTime::currentDateTime().toString(Qt::ISODateWithMs) << "  "
         << event;
  if (!detail.isEmpty()) stream << ": " << detail;
  stream << "\n";
#if QT_CONFIG(ssl)
  if (event.contains("ssl") || event.contains("connect") ||
      event.contains("error"))
    stream << "  TLS support: available=" << QSslSocket::supportsSsl()
           << " build=" << QSslSocket::sslLibraryBuildVersionString()
           << " runtime=" << QSslSocket::sslLibraryVersionString() << "\n";
#endif
}

void PartyClient::createRoom(const QUrl &serverUrl, const QString &mode,
                             int slotCount, int maxPlayers) {
  m_serverUrl = serverUrl;
  m_closing = false;
  m_backoffMs = 1000;
  QUrl url = m_serverUrl;
  url.setPath(QStringLiteral("/api/rooms"));
  QNetworkRequest request(url);
  request.setHeader(QNetworkRequest::ContentTypeHeader,
                    QStringLiteral("application/json"));
  QJsonObject body;
  if (!mode.isEmpty()) body.insert(QStringLiteral("mode"), mode);
  if (slotCount > 0) body.insert(QStringLiteral("slots"), slotCount);
  if (maxPlayers > 0) body.insert(QStringLiteral("maxPlayers"), maxPlayers);
  dumpDiag(QStringLiteral("create room request"),
           QStringLiteral("url=%1 mode=%2 slots=%3 tls=%4")
               .arg(url.toString())
               .arg(mode.isEmpty() ? QStringLiteral("classic") : mode)
               .arg(slotCount)
               .arg(QSslSocket::supportsSsl()));
  QNetworkReply *reply =
      m_nam->post(request, QJsonDocument(body).toJson(QJsonDocument::Compact));
  connect(reply, &QNetworkReply::finished, this, [this, reply] {
    const QNetworkReply::NetworkError err = reply->error();
    const QString errString = reply->errorString();
    const QByteArray body = reply->readAll();
    const QByteArray rawCookie = reply->rawHeader("Set-Cookie");
    reply->deleteLater();
    if (err != QNetworkReply::NoError) {
      dumpDiag(
          QStringLiteral("create room failed"),
          QStringLiteral("err=%1 (%2) httpStatus=%3 url=%4 body=%5")
              .arg(err)
              .arg(errString)
              .arg(reply->attribute(QNetworkRequest::HttpStatusCodeAttribute)
                       .toInt())
              .arg(reply->url().toString())
              .arg(QString(reply->readAll().left(512))));
      Q_EMIT partyError(errString);
      return;
    }
    m_room = QJsonDocument::fromJson(body).object().value("room").toString();
    m_token.clear();
    const QList<QNetworkCookie> cookies =
        QNetworkCookie::parseCookies(rawCookie);
    for (const QNetworkCookie &cookie : cookies) {
      if (cookie.name() == QByteArray("hw_session")) m_token = cookie.value();
    }
    if (m_room.isEmpty() || m_token.isEmpty()) {
      dumpDiag(QStringLiteral("create room: invalid response"),
               QStringLiteral("room='%1' cookie=%2 body=%3")
                   .arg(m_room)
                   .arg(m_token.isEmpty() ? "missing" : "ok")
                   .arg(QString(body.left(512))));
      Q_EMIT partyError(PartyClient::tr("Invalid party server response"));
      return;
    }
    Q_EMIT roomCreated(m_room);
    connectWs();
  });
}

void PartyClient::connectWs() {
  QUrl wsUrl = m_serverUrl;
  wsUrl.setScheme(m_serverUrl.scheme() == QStringLiteral("https")
                      ? QStringLiteral("wss")
                      : QStringLiteral("ws"));
  dumpDiag(QStringLiteral("ws connect"),
           QStringLiteral("url=%1 room=%2").arg(wsUrl.toString()).arg(m_room));
  wsUrl.setPath(QStringLiteral("/api/rooms/%1/ws").arg(m_room));
  QNetworkRequest request(wsUrl);
  request.setRawHeader(QByteArray("Cookie"),
                       QByteArray("hw_session=") + m_token.toUtf8());
  m_ws.open(request);
}

void PartyClient::disconnectParty() {
  m_closing = true;
  m_ws.close();
}

bool PartyClient::isConnected() const { return m_ws.isValid(); }

QString PartyClient::roomCode() const { return m_room; }

QString PartyClient::joinLink() const {
  return m_serverUrl.toString(QUrl::StripTrailingSlash) +
         QStringLiteral("?r=") + m_room;
}

void PartyClient::sendState(const QString &state) {
  QJsonObject obj;
  obj.insert(QStringLiteral("type"), QStringLiteral("state"));
  obj.insert(QStringLiteral("state"), state);
  m_ws.sendTextMessage(
      QString::fromUtf8(QJsonDocument(obj).toJson(QJsonDocument::Compact)));
}

void PartyClient::sendTurn(const QString &team, int hogIndex,
                           const QString &sid) {
  QJsonObject obj;
  obj.insert(QStringLiteral("type"), QStringLiteral("turn"));
  obj.insert(QStringLiteral("team"), team);
  if (hogIndex >= 0) obj.insert(QStringLiteral("hog"), hogIndex);
  if (!sid.isEmpty()) obj.insert(QStringLiteral("sid"), sid);
  m_ws.sendTextMessage(
      QString::fromUtf8(QJsonDocument(obj).toJson(QJsonDocument::Compact)));
}

void PartyClient::sendWeapons(const QString &ammoStore) {
  QJsonObject obj;
  obj.insert(QStringLiteral("type"), QStringLiteral("weapons"));
  obj.insert(QStringLiteral("ammo"), ammoStore);
  m_ws.sendTextMessage(
      QString::fromUtf8(QJsonDocument(obj).toJson(QJsonDocument::Compact)));
}

void PartyClient::sendAmmo(const QString &sid, const QString &ammo) {
  QJsonObject obj;
  obj.insert(QStringLiteral("type"), QStringLiteral("ammo"));
  obj.insert(QStringLiteral("sid"), sid);
  obj.insert(QStringLiteral("ammo"), ammo);
  m_ws.sendTextMessage(
      QString::fromUtf8(QJsonDocument(obj).toJson(QJsonDocument::Compact)));
}

void PartyClient::sendNotify(const QString &sid, const QString &text) {
  QJsonObject obj;
  obj.insert(QStringLiteral("type"), QStringLiteral("notify"));
  obj.insert(QStringLiteral("sid"), sid);
  obj.insert(QStringLiteral("text"), text);
  m_ws.sendTextMessage(
      QString::fromUtf8(QJsonDocument(obj).toJson(QJsonDocument::Compact)));
}

void PartyClient::sendSeat(const QString &sid, bool seated,
                           const QString &team) {
  QJsonObject obj;
  obj.insert(QStringLiteral("type"), QStringLiteral("seat"));
  obj.insert(QStringLiteral("sid"), sid);
  obj.insert(QStringLiteral("seated"), seated);
  if (!team.isEmpty()) obj.insert(QStringLiteral("team"), team);
  m_ws.sendTextMessage(
      QString::fromUtf8(QJsonDocument(obj).toJson(QJsonDocument::Compact)));
}

void PartyClient::sendAfk(const QString &team, int seconds) {
  QJsonObject obj;
  obj.insert(QStringLiteral("type"), QStringLiteral("afk"));
  obj.insert(QStringLiteral("team"), team);
  obj.insert(QStringLiteral("seconds"), seconds);
  obj.insert(QStringLiteral("endsAt"),
             static_cast<qint64>(QDateTime::currentMSecsSinceEpoch() +
                                 seconds * 1000));
  m_ws.sendTextMessage(
      QString::fromUtf8(QJsonDocument(obj).toJson(QJsonDocument::Compact)));
}

void PartyClient::sendAfkClear(const QString &team) {
  QJsonObject obj;
  obj.insert(QStringLiteral("type"), QStringLiteral("afk"));
  obj.insert(QStringLiteral("team"), team);
  obj.insert(QStringLiteral("clear"), true);
  m_ws.sendTextMessage(
      QString::fromUtf8(QJsonDocument(obj).toJson(QJsonDocument::Compact)));
}

void PartyClient::checkAlive(const QString &sid) {
  if (m_room.isEmpty() || m_token.isEmpty() || sid.isEmpty()) {
    Q_EMIT aliveChecked(sid, false);
    return;
  }
  QUrl url = m_serverUrl;
  url.setPath(QStringLiteral("/api/rooms/%1/alive/%2").arg(m_room, sid));
  QNetworkRequest request(url);
  request.setRawHeader(QByteArray("Cookie"),
                       QByteArray("hw_session=") + m_token.toUtf8());
  QNetworkReply *reply = m_nam->get(request);
  connect(reply, &QNetworkReply::finished, this, [this, reply, sid] {
    const bool ok = reply->error() == QNetworkReply::NoError;
    const QByteArray body = reply->readAll();
    reply->deleteLater();
    bool alive = false;
    if (ok) {
      alive = QJsonDocument::fromJson(body)
                  .object()
                  .value(QStringLiteral("alive"))
                  .toBool(false);
    }
    Q_EMIT aliveChecked(sid, alive);
  });
}

void PartyClient::handleMessage(const QString &message) {
  const QJsonObject obj = QJsonDocument::fromJson(message.toUtf8()).object();
  const QString type = obj.value(QStringLiteral("type")).toString();
  if (type == QStringLiteral("hello")) {
    m_backoffMs = 1000;
    Q_EMIT connected();
  } else if (type == QStringLiteral("joined")) {
    Q_EMIT memberJoined(obj.value(QStringLiteral("sid")).toString());
  } else if (type == QStringLiteral("left")) {
    Q_EMIT memberLeft(obj.value(QStringLiteral("sid")).toString());
  } else if (type == QStringLiteral("team")) {
    const QJsonObject seatObj = obj.value(QStringLiteral("seat")).toObject();
    Q_EMIT teamRegistered(obj.value(QStringLiteral("sid")).toString(),
                          obj.value(QStringLiteral("config")).toObject(),
                          seatObj.contains(QStringLiteral("slot"))
                              ? seatObj.value(QStringLiteral("slot")).toInt(-1)
                              : -1);
  } else if (type == QStringLiteral("input")) {
    Q_EMIT inputReceived(obj.value(QStringLiteral("sid")).toString(),
                         obj.value(QStringLiteral("action")).toString());
  } else if (type == QStringLiteral("cursor")) {
    Q_EMIT cursorReceived(obj.value(QStringLiteral("sid")).toString(),
                          obj.value(QStringLiteral("x")).toInt(),
                          obj.value(QStringLiteral("y")).toInt());
  } else if (type == QStringLiteral("put")) {
    Q_EMIT putReceived(obj.value(QStringLiteral("sid")).toString(),
                       obj.value(QStringLiteral("x")).toInt(),
                       obj.value(QStringLiteral("y")).toInt());
  }
}
