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

#include "partylayout.h"

#include <QJsonArray>
#include <algorithm>

namespace {
struct TeamDef {
  const char *name;
  unsigned int color;
};
const TeamDef kTeamDefs[] = {{"Red", 0xff0000},
                             {"Blue", 0x0000ff},
                             {"Yellow", 0xffff00},
                             {"Green", 0x00ff00}};
}  // namespace

int PartyLayout::teamCountFor(int players) {
  return players <= 12 ? 2 : players <= 18 ? 3 : 4;
}

PartyLayout::PartyLayout(Mode mode, int max) : m_mode(mode), m_max(max) {
  for (int i = 0; i < 2; i++)
    m_teams.append(
        {QString::fromLatin1(kTeamDefs[i].name), kTeamDefs[i].color, {}});
}

int PartyLayout::joined() const {
  int n = m_waiting.size();
  for (const PartyTeam &t : m_teams) n += t.members.size();
  return n;
}

int PartyLayout::seated() const { return joined() - m_waiting.size(); }

bool PartyLayout::has(const QString &sid) const {
  for (const PartyTeam &t : m_teams)
    for (const PartyMember &m : t.members)
      if (m.sid == sid) return true;
  for (const PartyMember &m : m_waiting)
    if (m.sid == sid) return true;
  return false;
}

QString PartyLayout::teamOf(const QString &sid) const {
  for (const PartyTeam &t : m_teams)
    for (const PartyMember &m : t.members)
      if (m.sid == sid) return t.name;
  return QString();
}

int PartyLayout::hogCount(const PartyTeam &team) const {
  return std::max(kMinHogs, static_cast<int>(team.members.size()));
}

bool PartyLayout::join(const QString &sid, const QString &name) {
  if (has(sid) || joined() >= m_max) return false;
  PartyMember p;
  p.sid = sid;
  p.name = name;
  p.n = m_seq++;
  m_waiting.append(p);
  settle();
  return true;
}

bool PartyLayout::leave(const QString &sid) {
  for (PartyTeam &t : m_teams) {
    for (int i = 0; i < t.members.size(); i++) {
      if (t.members.at(i).sid == sid) {
        t.members.removeAt(i);
        settle();
        return true;
      }
    }
  }
  for (int i = 0; i < m_waiting.size(); i++) {
    if (m_waiting.at(i).sid == sid) {
      m_waiting.removeAt(i);
      settle();
      return true;
    }
  }
  return false;
}

void PartyLayout::settle() {
  if (m_mode == Pairs)
    settlePairs();
  else
    settleBalanced();
}

void PartyLayout::settlePairs() {
  PartyTeam &red = m_teams[0];
  PartyTeam &blue = m_teams[1];
  // the sides must be exactly even: bench the latest-seated player of the
  // bigger side and put them first in line, remembering where they sat
  while (red.members.size() != blue.members.size()) {
    PartyTeam &big = red.members.size() > blue.members.size() ? red : blue;
    PartyMember out = big.members.takeLast();
    out.prev = big.name;
    m_waiting.prepend(out);
  }
  // seat waiting players two at a time, one per team
  while (m_waiting.size() >= 2 && seated() + 2 <= m_max) {
    PartyMember a = m_waiting.takeFirst();
    PartyMember b = m_waiting.takeFirst();
    PartyTeam &aTeam = a.prev == QLatin1String("Blue") ? blue : red;
    PartyTeam &bTeam = (&aTeam == &red) ? blue : red;
    a.prev.clear();
    b.prev.clear();
    aTeam.members.append(a);
    bTeam.members.append(b);
  }
}

void PartyLayout::settleBalanced() {
  // everybody is seated; players only ever wait in the Pairs mode
  const int T = teamCountFor(joined());
  QList<PartyMember> pool = m_waiting;
  m_waiting.clear();
  while (m_teams.size() < T) {
    const TeamDef &d = kTeamDefs[m_teams.size()];
    m_teams.append({QString::fromLatin1(d.name), d.color, {}});
  }
  while (m_teams.size() > T) pool.append(m_teams.takeLast().members);
  std::stable_sort(
      pool.begin(), pool.end(),
      [](const PartyMember &x, const PartyMember &y) { return x.n < y.n; });

  // first minimal / first maximal, exactly as the JavaScript reduce picks them
  auto smallest = [this]() -> PartyTeam & {
    PartyTeam *s = &m_teams[0];
    for (PartyTeam &t : m_teams)
      if (t.members.size() < s->members.size()) s = &t;
    return *s;
  };
  auto largest = [this]() -> PartyTeam & {
    PartyTeam *l = &m_teams[0];
    for (PartyTeam &t : m_teams)
      if (t.members.size() > l->members.size()) l = &t;
    return *l;
  };

  for (const PartyMember &p : pool) smallest().members.append(p);
  // within one player of even: move the latest arrival of the biggest team
  for (;;) {
    PartyTeam &big = largest();
    PartyTeam &small = smallest();
    if (big.members.size() - small.members.size() <= 1) break;
    int latest = 0;
    for (int i = 0; i < big.members.size(); i++)
      if (big.members.at(i).n > big.members.at(latest).n) latest = i;
    const PartyMember moved = big.members.takeAt(latest);
    small.members.append(moved);
  }
  for (PartyTeam &t : m_teams)
    std::stable_sort(
        t.members.begin(), t.members.end(),
        [](const PartyMember &x, const PartyMember &y) { return x.n < y.n; });
}

QJsonObject PartyLayout::snapshot() const {
  QJsonArray teams;
  for (const PartyTeam &t : m_teams) {
    QJsonArray seats;
    for (int i = 0; i < hogCount(t); i++) {
      if (i < t.members.size()) {
        QJsonObject o;
        o.insert(QStringLiteral("name"), t.members.at(i).name);
        seats.append(o);
      } else {
        seats.append(QJsonValue::Null);
      }
    }
    QJsonObject to;
    to.insert(QStringLiteral("name"), t.name);
    to.insert(QStringLiteral("color"), static_cast<double>(t.color));
    to.insert(QStringLiteral("seats"), seats);
    teams.append(to);
  }
  QJsonArray waiting;
  for (const PartyMember &w : m_waiting) {
    QJsonObject o;
    o.insert(QStringLiteral("name"), w.name);
    waiting.append(o);
  }
  QJsonObject out;
  out.insert(QStringLiteral("teams"), teams);
  out.insert(QStringLiteral("waiting"), waiting);
  out.insert(QStringLiteral("joined"), joined());
  out.insert(QStringLiteral("capacity"), m_max);
  return out;
}
