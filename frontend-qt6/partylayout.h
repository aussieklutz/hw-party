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

// partylayout.h - who sits where in a team/imposter party lobby. A pure
// container with no I/O: the party host (HWForm) feeds it joins and leaves and
// draws whatever it says. It is the C++ twin of stream-host/agent/layout.mjs
// (tests/layout-diff.mjs drives both with the same random operations and
// compares them), so the stream host and the launcher seat players identically.
//
//   Pairs     (imposter) two teams, Red and Blue. Everyone who arrives is IN
//             the lobby at once but only SEATED two at a time (one per team) so
//             the sides are exactly even; the odd player out waits. A seated
//             player leaving unseats the most recently seated player on the
//             OTHER team; waiting players are re-seated as pairs, longest
//             waiting first.
//
//   Balanced  (teams) everyone is seated: two teams up to 12 players, three up
//             to 18, four up to 24 (Red, Blue, Yellow, Green), within one
//             player of even, moving as few players as possible when the team
//             count changes.
//
// A team fields at least kMinHogs hogs (the rest are CPU) and one more per
// extra player.

#ifndef PARTYLAYOUT_H
#define PARTYLAYOUT_H

#include <QJsonObject>
#include <QList>
#include <QString>

struct PartyMember {
  QString sid;
  QString name;
  int n = 0;     // arrival order
  QString prev;  // team they were benched from (Pairs), else empty
};

struct PartyTeam {
  QString name;
  unsigned int color = 0;  // 0xRRGGBB
  QList<PartyMember> members;
};

class PartyLayout {
 public:
  enum Mode { Pairs, Balanced };
  static constexpr int kMinHogs = 3;

  PartyLayout(Mode mode = Balanced, int max = 24);

  bool join(const QString &sid, const QString &name);
  bool leave(const QString &sid);
  bool has(const QString &sid) const;

  int joined() const;
  int seated() const;
  int max() const { return m_max; }
  Mode mode() const { return m_mode; }
  const QList<PartyTeam> &teams() const { return m_teams; }
  const QList<PartyMember> &waiting() const { return m_waiting; }

  // hogs a team fields: at least kMinHogs, one per extra player
  int hogCount(const PartyTeam &team) const;
  // which team a player is seated on ("" if waiting or unknown)
  QString teamOf(const QString &sid) const;

  // for the log and the comparison test: {teams:[{name,seats:[names]}],
  // waiting:[names], joined}
  QJsonObject snapshot() const;

  static int teamCountFor(int players);

 private:
  void settle();
  void settlePairs();
  void settleBalanced();

  Mode m_mode;
  int m_max;
  int m_seq = 0;
  QList<PartyTeam> m_teams;
  QList<PartyMember> m_waiting;
};

#endif
