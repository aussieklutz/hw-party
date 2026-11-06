/*
 * Hedgewars, a free turn based strategy game
 * Copyright (c) 2026 Hedgewars contributors
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

// partyhostcore.h - what the party host decides in the TEAM and IMPOSTER modes,
// with no user interface and no network in it: HWForm feeds it what happens
// (a phone registered, a phone left, the engine announced a turn, ...) and
// applies what it says (tell this phone where it sits, send the engine this
// command, show these roster lines). That keeps the rules testable on their own
// (party/dev/host-core-test.cpp plays whole games through it) and identical to
// the stream host agent's (stream-host/agent/host-agent.mjs).
//
//  - the lobby (PartyLayout): everyone in at once, seated per the mode's rules
//  - at the start: engine teams (min 3 hogs, 2-4 teams), one secret traitor per
//    team in the imposter mode, players still unseated sit this game out
//  - in the game: the engine is told "traitor <hog> <team>" at every turn start
//    (it only acts when that hog is its team's last), a swapped traitor's clone
//    plays on the traitor's phone, a dropped player's hog is skipped and given
//    back when they return
//  - at the end: the imposters are revealed, a fresh lobby opens and the
//  players
//    who were left unseated go first in it

#ifndef PARTYHOSTCORE_H
#define PARTYHOSTCORE_H

#include <QHash>
#include <QList>
#include <QObject>
#include <QString>
#include <QStringList>
#include <functional>

#include "partylayout.h"

class PartyHostCore : public QObject {
  Q_OBJECT

 public:
  struct PlannedHog {
    QString name;
    QString sid;  // empty: an engine-driven CPU hog
    bool human = false;
  };
  struct PlannedTeam {
    QString name;
    int paletteIndex = 0;  // index in the launcher's team colour table
    QList<PlannedHog> hogs;
  };
  struct Imposter {
    QString sid, name, team;
    int hogIdx = 0;
    bool defected = false;
    QString cloneTeam;  // where the engine will put the traitor's clone
    int cloneIdx = -1;
  };
  struct TurnInfo {
    bool valid = false;  // the team is one of ours
    QString sid;         // who plays this hog ("" for a CPU or vacated hog)
    bool vacantSkip = false;  // a player's hog whose player left: skip the turn
  };

  explicit PartyHostCore(QObject *parent = nullptr);

  // tests inject a deterministic pick: pick(n) is in [0, n)
  void setRandom(std::function<int(int)> pick) { m_pick = std::move(pick); }

  // a new room or a new round: an empty lobby (the carried-over players first)
  void reset(const QString &mode, int maxPlayers,
             const QList<PartyMember> &carryOver = QList<PartyMember>());
  bool active() const;                      // team or imposter mode
  bool locked() const { return m_locked; }  // the round has started
  const PartyLayout &layout() const { return m_layout; }
  const QList<Imposter> &imposters() const { return m_imposters; }
  const QList<PartyMember> &unseatedAtStart() const { return m_unseated; }

  // lobby
  void registered(const QString &sid, const QString &name);
  // returns a line for the roster box when the game is running ("" otherwise)
  QString memberLeft(const QString &sid);

  // round
  QString startError() const;  // "" when the round can start
  int seatedHumans() const { return m_layout.seated(); }
  QList<PlannedTeam> start();  // freezes the lobby, picks the traitors
  void announce();  // after the game began: tell each traitor, tell the waiting
  TurnInfo turn(const QString &team, int hogIdx);
  void traitorSwapped(const QString &fromTeam);
  void gameEnded();

  static constexpr int kSlotsPerTeam = 8;  // slot = teamIndex * 8 + hogIndex

 Q_SIGNALS:
  void seatNotice(const QString &sid, bool seated, const QString &team);
  void notify(const QString &sid, const QString &text);
  void engineCommand(const QString &command);
  void rosterLines(const QStringList &lines);  // the whole roster box
  void rosterNote(const QString &line);        // one more line in it

 private:
  void lobbyChanged();
  QString roleText(const Imposter &imp) const;

  QString m_mode;
  PartyLayout m_layout;
  bool m_locked = false;
  QHash<QString, QString>
      m_notice;  // sid -> last "Red" | "waiting" told to the phone
  QList<Imposter> m_imposters;
  QList<PartyMember> m_unseated;
  QHash<int, QString> m_seatToSid;
  QHash<int, QString> m_seatNames;
  QHash<QString, int> m_teamBase;
  QList<int> m_vacant;
  std::function<int(int)> m_pick;
};

#endif
