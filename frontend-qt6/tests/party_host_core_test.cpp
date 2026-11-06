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

// party_host_core_test.cpp - plays whole team / imposter games through
// PartyHostCore, the rules the Qt launcher's party host follows, with fake
// phones and a fake engine: it records every message the core sends and asserts
// on it. Run by the party_host_core_test CTest target.
#include <QCoreApplication>
#include <QStringList>
#include <iostream>

#include "partyhostcore.h"

static int failures = 0;
static void check(const char *name, bool ok,
                  const QString &detail = QString()) {
  std::cout << (ok ? "PASS  " : "FAIL  ") << name;
  if (!detail.isEmpty()) std::cout << "  -- " << detail.toStdString();
  std::cout << std::endl;
  if (!ok) failures++;
}

struct Wire {  // everything the core says, in order
  struct Seat {
    QString sid;
    bool seated;
    QString team;
  };
  QList<Seat> seats;
  QList<QPair<QString, QString>> notifies;
  QStringList commands, notes, roster;
  void clear() {
    seats.clear();
    notifies.clear();
    commands.clear();
    notes.clear();
    roster.clear();
  }
  QString lastSeat(const QString &sid) const {
    for (int i = seats.size() - 1; i >= 0; --i)
      if (seats.at(i).sid == sid)
        return seats.at(i).seated ? seats.at(i).team
                                  : QStringLiteral("waiting");
    return QStringLiteral("(none)");
  }
  QStringList notifiedTo(const QString &sid) const {
    QStringList t;
    for (const auto &n : notifies)
      if (n.first == sid) t << n.second;
    return t;
  }
};

static void wire(PartyHostCore &core, Wire &w) {
  QObject::connect(&core, &PartyHostCore::seatNotice,
                   [&w](const QString &sid, bool seated, const QString &team) {
                     w.seats.append({sid, seated, team});
                   });
  QObject::connect(&core, &PartyHostCore::notify,
                   [&w](const QString &sid, const QString &text) {
                     w.notifies.append({sid, text});
                   });
  QObject::connect(&core, &PartyHostCore::engineCommand,
                   [&w](const QString &c) { w.commands << c; });
  QObject::connect(&core, &PartyHostCore::rosterLines,
                   [&w](const QStringList &l) { w.roster = l; });
  QObject::connect(&core, &PartyHostCore::rosterNote,
                   [&w](const QString &l) { w.notes << l; });
}

static void join(PartyHostCore &c, int from, int to) {
  for (int i = from; i <= to; ++i)
    c.registered(QStringLiteral("s%1").arg(i), QStringLiteral("P%1").arg(i));
}

int main(int argc, char **argv) {
  QCoreApplication app(argc, argv);

  // ================================================================ imposter
  // ====
  std::cout << "\n-- imposter lobby" << std::endl;
  PartyHostCore core;
  Wire w;
  wire(core, w);
  core.setRandom([](int) {
    return 0;
  });  // the first seated player of each team is the traitor
  core.reset("imposter", 12);
  check("the host core is active in the imposter mode",
        core.active() && !core.locked());

  core.registered("s1", "P1");
  check("a lone arrival is in the lobby, waiting for a partner",
        w.lastSeat("s1") == "waiting" && core.layout().joined() == 1 &&
            core.layout().seated() == 0);
  core.registered("s2", "P2");
  check("the second arrival seats both, one per team",
        w.lastSeat("s1") == "Red" && w.lastSeat("s2") == "Blue");
  join(core, 3, 7);
  check("7 in: 3v3 seated, the 7th waits",
        core.layout().seated() == 6 && w.lastSeat("s7") == "waiting");
  check("the roster box lists the teams and who waits",
        w.roster.join("|").contains("Red (3): P1, P3, P5") &&
            w.roster.join("|").contains("Blue (3): P2, P4, P6") &&
            w.roster.join("|").contains("Waiting for a partner: P7"),
        w.roster.join(" | "));
  check("a repeated registration does nothing",
        (core.registered("s3", "P3"), core.layout().joined() == 7));

  w.clear();
  core.memberLeft("s3");  // a Red player drops out of the lobby
  check(
      "a seated player drops: the LAST player on the other team is unseated "
      "and the waiter is paired with them",
      core.layout().seated() == 6 && core.layout().waiting().isEmpty(),
      QString::number(core.layout().seated()));
  check("the phones that moved are told", !w.seats.isEmpty());
  core.registered("s3", "P3");  // they come back: waiting again (7 in, 3v3 + 1)
  check("back to 3v3 + one waiting",
        core.layout().seated() == 6 && core.layout().waiting().size() == 1);

  PartyHostCore small;
  small.reset("imposter", 12);
  join(small, 1, 5);
  check("5 players cannot start an imposter game",
        !small.startError().isEmpty(), small.startError());
  join(small, 6, 6);
  check("6 players can", small.startError().isEmpty(), small.startError());

  // ------------------------------------------------------------ the game
  // ------
  std::cout << "\n-- starting: engine teams, one traitor per team" << std::endl;
  const QString waiting = core.layout().waiting().first().sid;
  const QString waitingName = core.layout().waiting().first().name;
  check("the round can start with 6 seated", core.startError().isEmpty());
  w.clear();
  const auto plan = core.start();
  check("two teams, Red then Blue", plan.size() == 2 &&
                                        plan.at(0).name == "Red" &&
                                        plan.at(1).name == "Blue");
  check("each team fields 3 hogs, all human",
        plan.at(0).hogs.size() == 3 && plan.at(1).hogs.size() == 3 &&
            plan.at(0).hogs.at(0).human && plan.at(1).hogs.at(2).human);
  check(
      "a hog is named after its player",
      plan.at(0).hogs.at(0).name == "P1" && plan.at(1).hogs.at(0).name == "P2");
  check("the colours are red and blue in the launcher's table",
        plan.at(0).paletteIndex == 0 && plan.at(1).paletteIndex == 1);
  check("there is one imposter on each team",
        core.imposters().size() == 2 && core.imposters().at(0).team == "Red" &&
            core.imposters().at(1).team == "Blue");
  check("the lobby is frozen", core.locked());
  check("the unseated player is recorded to go first next time",
        core.unseatedAtStart().size() == 1 &&
            core.unseatedAtStart().first().sid == waiting);
  check("nothing was sent to a phone before the game began",
        w.notifies.isEmpty());
  core.announce();
  const QStringList redNote = w.notifiedTo(core.imposters().at(0).sid);
  const QStringList blueNote = w.notifiedTo(core.imposters().at(1).sid);
  check("each traitor is told privately which team they are on",
        redNote.size() == 1 &&
            redNote.first().contains("IMPOSTER on the Red team") &&
            blueNote.size() == 1 &&
            blueNote.first().contains("IMPOSTER on the Blue team"),
        (redNote + blueNote).join(" / "));
  check(
      "the unseated player is told why they sit out",
      w.notifiedTo(waiting).size() == 1 &&
          w.notifiedTo(waiting).first().contains("go first in the next lobby"));
  check("nobody else was sent anything", w.notifies.size() == 3);

  // ------------------------------------------------------------ turns
  // ---------
  std::cout << "\n-- turns, the traitor command and defection" << std::endl;
  w.clear();
  auto t = core.turn("Red", 1);
  check("a turn routes to the hog's player",
        t.valid && t.sid == plan.at(0).hogs.at(1).sid && !t.vacantSkip, t.sid);
  check("the engine is told the traitor of EACH team every turn",
        w.commands == QStringList({"traitor 0 Red", "traitor 0 Blue"}),
        w.commands.join(", "));
  t = core.turn("Green", 0);
  check("a turn on a team that is not ours is ignored", !t.valid);
  t = core.turn("Blue", -1);
  check("the team-only notice (no hog index) is ignored", !t.valid);

  w.clear();
  core.traitorSwapped("Red");
  check("the engine's swap notice marks the Red traitor as defected",
        core.imposters().at(0).defected && !core.imposters().at(1).defected &&
            w.notes.size() == 1 &&
            w.notes.first().contains("defected from Red"),
        w.notes.join("|"));
  core.traitorSwapped("Red");
  check("a repeated notice changes nothing", w.notes.size() == 1);
  w.clear();
  t = core.turn("Blue", 3);  // the clone is the 4th hog (index 3) of Blue
  check("the clone's turns go to the traitor's phone", t.valid && t.sid == "s1",
        t.sid);
  check("only the traitor who has not defected is still named to the engine",
        w.commands == QStringList({"traitor 0 Blue"}), w.commands.join(", "));
  t = core.turn("Blue", 2);
  check("a normal Blue hog still goes to its own player", t.sid == "s6", t.sid);

  // ------------------------------------------------------------ drops
  // ---------
  std::cout << "\n-- a player drops out mid-game and comes back" << std::endl;
  w.clear();
  const QString line = core.memberLeft("s6");
  check("a mid-game drop is reported for the roster", line.contains("dropped"),
        line);
  t = core.turn("Blue", 2);
  check("their hog has no player and is skipped",
        t.valid && t.sid.isEmpty() && t.vacantSkip);
  core.registered("s6b", "P6");  // same screen name, a fresh session
  check("they take their hog back by screen name",
        w.notes.last().contains("is back"), w.notes.last());
  t = core.turn("Blue", 2);
  check("and it plays for the new session", t.sid == "s6b" && !t.vacantSkip,
        t.sid);
  core.registered("s9", "Latecomer");
  check("a stranger arriving mid-game spectates",
        w.notes.last().contains("too late"));

  w.clear();
  const QString blueTraitor = core.imposters().at(1).sid;  // s2, P2
  core.memberLeft(blueTraitor);
  core.registered("s2b", "P2");
  check("a returning traitor is reminded who they are",
        w.notifiedTo("s2b").size() == 1 &&
            w.notifiedTo("s2b").first().contains("IMPOSTER on the Blue team"));
  check("and the imposter record follows their new session",
        core.imposters().at(1).sid == "s2b");
  check("a returning player's hog is theirs again",
        core.turn("Blue", 0).sid == "s2b");

  // ------------------------------------------------------------ the end
  // -------
  std::cout << "\n-- the game ends" << std::endl;
  w.clear();
  core.gameEnded();
  check("a fresh lobby opens, unlocked", !core.locked());
  check("the player left unseated goes FIRST in the next lobby",
        core.layout().joined() == 1 && core.layout().waiting().size() == 1 &&
            core.layout().waiting().first().sid == waiting &&
            core.layout().waiting().first().name == waitingName);
  const QStringList reveal = w.notifiedTo("s1");
  check("the imposters are revealed to the players, defection included",
        reveal.size() == 1 && reveal.first().contains("P1 (Red, defected)") &&
            reveal.first().contains("P2 (Blue)"),
        reveal.join("|"));
  check("...and to the player who sat this one out",
        w.notifiedTo(waiting).size() == 1 &&
            w.notifiedTo(waiting).first().contains("The imposters were"));
  const int notified = w.notifies.size();
  core.gameEnded();
  check("a second end-of-game report does nothing (it can arrive twice)",
        w.notifies.size() == notified && core.layout().joined() == 1);
  check("the carried-over player is told they wait for a partner",
        w.lastSeat(waiting) == "waiting");

  // =================================================================== teams
  // ====
  std::cout << "\n-- teams mode: 2 to 4 teams, CPU fills to 3 hogs"
            << std::endl;
  PartyHostCore tm;
  Wire tw;
  wire(tm, tw);
  tm.reset("teams", 24);
  check("a lone player is seated at once (no pairing in the team mode)",
        (tm.registered("a1", "Solo"), tw.lastSeat("a1") == "Red"));
  auto solo = tm.start();
  check("one player: Red has one human hog and two CPU, Blue is all CPU",
        solo.size() == 2 && solo.at(0).hogs.size() == 3 &&
            solo.at(0).hogs.at(0).human && !solo.at(0).hogs.at(1).human &&
            !solo.at(1).hogs.at(0).human && solo.at(1).hogs.size() == 3);
  check("the team mode has no imposters", tm.imposters().isEmpty());
  tm.announce();
  check("...and so tells nobody anything", tw.notifies.isEmpty());
  t = tm.turn("Red", 1);
  check("a CPU hog has no player and no skip",
        t.valid && t.sid.isEmpty() && !t.vacantSkip);
  check("the team mode sends the engine no traitor command",
        tw.commands.isEmpty());
  tm.gameEnded();

  tm.reset("teams", 24);
  join(tm, 1, 13);
  auto three = tm.start();
  check("13 players make three teams (Red, Blue, Yellow)",
        three.size() == 3 && three.at(2).name == "Yellow" &&
            three.at(2).paletteIndex == 8);
  int hogs = 0;
  for (const auto &team : three) hogs += team.hogs.size();
  check("they field 13 hogs between them, none below 3 a team",
        hogs == 13 && three.at(0).hogs.size() >= 3 &&
            three.at(2).hogs.size() >= 3);
  tm.reset("teams", 24);
  join(tm, 1, 19);
  auto four = tm.start();
  check("19 players make four teams, the fourth is Green",
        four.size() == 4 && four.at(3).name == "Green" &&
            four.at(3).paletteIndex == 5);
  tm.reset("teams", 24);
  join(tm, 1, 24);
  check("24 players fit", tm.layout().joined() == 24);
  tw.clear();
  tm.registered("x25", "TooMany");
  check("the 25th is told the lobby is full",
        tw.notes.size() == 1 && tw.notes.first().contains("Lobby full"));

  PartyHostCore none;
  none.reset("teams", 24);
  check("an empty team lobby cannot start", !none.startError().isEmpty());

  // ================================================================ standard
  // ====
  std::cout << "\n-- the standard modes are left alone" << std::endl;
  PartyHostCore classic;
  Wire cw;
  wire(classic, cw);
  classic.reset("classic", 4);
  classic.registered("c1", "Team Phone");
  check(
      "classic: the core does nothing (the form registers whole teams itself)",
      !classic.active() && cw.seats.isEmpty() && cw.notes.isEmpty() &&
          classic.startError().isEmpty());
  classic.reset("fixed", 4);
  check("fixed: the core stays out of it", !classic.active());

  // an imposter lobby never grows past 12
  PartyHostCore cap;
  cap.reset("imposter", 99);
  join(cap, 1, 14);
  check(
      "an imposter lobby is capped at 12 however large a number was asked for",
      cap.layout().joined() == 12 && cap.layout().max() == 12);

  std::cout << (failures ? "\nFAILED: " : "\nall checks passed")
            << (failures ? QString::number(failures).toStdString() + " check(s)"
                         : "")
            << std::endl;
  return failures ? 1 : 0;
}
