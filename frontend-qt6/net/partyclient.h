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

#ifndef PARTYCLIENT_H
#define PARTYCLIENT_H

#include <QJsonObject>
#include <QObject>
#include <QUrl>
#include <QWebSocket>

class QNetworkAccessManager;

class PartyClient : public QObject {
  Q_OBJECT

 public:
  explicit PartyClient(QObject *parent = nullptr);

  // maxPlayers (team/imposter modes): how many players the room seats, up to 24
  void createRoom(const QUrl &serverUrl, const QString &mode, int slotCount = 0,
                  int maxPlayers = 0);
  void disconnectParty();
  bool isConnected() const;
  QString roomCode() const;
  QString joinLink() const;

 public Q_SLOTS:
  void sendState(const QString &state);
  void sendTurn(const QString &team, int hogIndex = -1,
                const QString &sid = QString());
  void sendWeapons(const QString &ammoStore);
  // the active player's ammo counts and turns to wait, to that one phone
  void sendAmmo(const QString &sid, const QString &ammo);
  // private messages to ONE phone (the room routes them by sid): the imposter
  // reveal, "you are seated on Red / waiting for a partner"
  void sendNotify(const QString &sid, const QString &text);
  void sendSeat(const QString &sid, bool seated, const QString &team);
  // AFK turn countdown (a sleeping phone skips its turn): the host
  // pauses the engine and tells the controllers to count down
  void sendAfk(const QString &team, int seconds);
  void sendAfkClear(const QString &team);
  // liveness probe for the active controller: GET /alive/<sid> with the
  // host session cookie; the result arrives via aliveChecked()
  void checkAlive(const QString &sid);

 Q_SIGNALS:
  void roomCreated(const QString &code);
  void connected();
  void disconnected(const QString &reason);
  void memberJoined(const QString &sid);
  void memberLeft(const QString &sid);
  void teamRegistered(const QString &sid, const QJsonObject &config, int seat);
  void inputReceived(const QString &sid, const QString &action);
  void cursorReceived(const QString &sid, int x, int y);
  void putReceived(const QString &sid, int x, int y);
  void aliveChecked(const QString &sid, bool alive);
  void partyError(const QString &message);

 private Q_SLOTS:
  void handleMessage(const QString &message);

 private:
  void connectWs();

  QWebSocket m_ws;
  QNetworkAccessManager *m_nam;

  void dumpDiag(const QString &event, const QString &detail = QString());
  QUrl m_serverUrl;
  QString m_room;
  QString m_token;
  // automatic reconnect after an unexpected drop: the host socket is
  // long-lived and the worker (or the network) may close it while the game
  // or lobby sits idle; on reconnect the DO replays state + registrations
  bool m_closing = false;
  int m_backoffMs = 1000;
};

#endif
