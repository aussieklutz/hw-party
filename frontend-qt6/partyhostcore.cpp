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

#include "partyhostcore.h"

#include <QRandomGenerator>
#include <QSet>
#include <algorithm>

namespace {
// the launcher's default colour table (hwconsts.h): red, blue, yellow, green
const int kPalette[] = {0, 1, 8, 5};
}  // namespace

PartyHostCore::PartyHostCore(QObject *parent)
    : QObject(parent), m_layout(PartyLayout::Balanced, 24) {
  m_pick = [](int n) {
    return static_cast<int>(QRandomGenerator::global()->bounded(
        static_cast<quint32>(std::max(1, n))));
  };
}

bool PartyHostCore::active() const {
  return m_mode == QLatin1String("teams") ||
         m_mode == QLatin1String("imposter");
}

void PartyHostCore::reset(const QString &mode, int maxPlayers,
                          const QList<PartyMember> &carryOver) {
  m_mode = mode;
  const bool imposter = mode == QLatin1String("imposter");
  const int cap =
      imposter ? std::clamp(maxPlayers, 6, 12) : std::clamp(maxPlayers, 2, 24);
  m_layout =
      PartyLayout(imposter ? PartyLayout::Pairs : PartyLayout::Balanced, cap);
  m_locked = false;
  m_notice.clear();
  m_imposters.clear();
  m_unseated.clear();
  m_seatToSid.clear();
  m_seatNames.clear();
  m_teamBase.clear();
  m_vacant.clear();
  // players left unseated when the last game began go first in this lobby
  if (active())
    for (const PartyMember &m : carryOver) m_layout.join(m.sid, m.name);
  lobbyChanged();
}

// tell each phone where it sits (only when that changed) and redraw the roster
// box
void PartyHostCore::lobbyChanged() {
  if (!active()) return;
  QHash<QString, QString> now;
  for (const PartyTeam &t : m_layout.teams())
    for (const PartyMember &m : t.members) now.insert(m.sid, t.name);
  for (const PartyMember &w : m_layout.waiting())
    now.insert(w.sid, QStringLiteral("waiting"));
  for (auto it = now.constBegin(); it != now.constEnd(); ++it) {
    if (m_notice.value(it.key()) == it.value()) continue;
    m_notice.insert(it.key(), it.value());
    const bool waiting = it.value() == QLatin1String("waiting");
    Q_EMIT seatNotice(it.key(), !waiting, waiting ? QString() : it.value());
  }
  for (auto it = m_notice.begin(); it != m_notice.end();) {
    if (!now.contains(it.key()))
      it = m_notice.erase(it);
    else
      ++it;
  }

  QStringList lines;
  lines << tr("You (host)");
  lines << tr("%1 of %2 players in").arg(m_layout.joined()).arg(m_layout.max());
  for (const PartyTeam &t : m_layout.teams()) {
    if (t.members.isEmpty()) continue;
    QStringList names;
    for (const PartyMember &m : t.members) names << m.name;
    lines << QStringLiteral("%1 (%2): %3")
                 .arg(t.name)
                 .arg(t.members.size())
                 .arg(names.join(QStringLiteral(", ")));
  }
  if (!m_layout.waiting().isEmpty()) {
    QStringList names;
    for (const PartyMember &m : m_layout.waiting()) names << m.name;
    lines << tr("Waiting for a partner: %1")
                 .arg(names.join(QStringLiteral(", ")));
  }
  Q_EMIT rosterLines(lines);
}

QString PartyHostCore::roleText(const Imposter &imp) const {
  return tr("You are the IMPOSTER on the %1 team. Play along - if you end up "
            "as %1's "
            "last hog you switch sides and win with the other team.")
      .arg(imp.team);
}

void PartyHostCore::registered(const QString &sid, const QString &rawName) {
  if (!active()) return;
  QString name = rawName.trimmed().left(40);
  if (name.isEmpty()) name = tr("Player %1").arg(sid.left(4));

  if (m_locked) {
    // mid-game: a returning player takes their vacated hog back (by screen
    // name)
    for (const int slot : m_vacant) {
      if (m_seatNames.value(slot) != name) continue;
      m_seatToSid[slot] = sid;
      m_vacant.removeAll(slot);
      for (Imposter &imp : m_imposters) {
        if (m_teamBase.value(imp.team, -1) + imp.hogIdx != slot) continue;
        imp.sid = sid;  // a returning traitor is reminded who they are
        Q_EMIT notify(sid, roleText(imp));
      }
      Q_EMIT rosterNote(tr("%1 is back at their hog").arg(name));
      return;
    }
    Q_EMIT rosterNote(tr("%1 joined too late and spectates").arg(name));
    return;
  }

  if (m_layout.has(sid)) return;  // already in
  if (!m_layout.join(sid, name)) {
    Q_EMIT rosterNote(tr("Lobby full: %1 cannot join").arg(name));
    return;
  }
  lobbyChanged();
}

QString PartyHostCore::memberLeft(const QString &sid) {
  if (!active()) return QString();
  if (!m_locked) {
    // dropped out of the filling lobby: the layout evens itself out (the latest
    // player on the other team may be unseated)
    if (m_layout.leave(sid)) lobbyChanged();
    return QString();
  }
  // the game is running: a waiting player who leaves no longer goes first next
  // time
  for (int i = m_unseated.size() - 1; i >= 0; --i)
    if (m_unseated.at(i).sid == sid) m_unseated.removeAt(i);
  // vacate their hogs: they idle out via auto-skip until a rejoin
  QList<int> bound;
  for (auto it = m_seatToSid.constBegin(); it != m_seatToSid.constEnd(); ++it)
    if (it.value() == sid) bound.append(it.key());
  if (bound.isEmpty()) return QString();
  for (const int slot : bound) {
    m_vacant.append(slot);
    m_seatToSid.remove(slot);
  }
  return tr("Player %1 dropped (seat waits for rejoin)").arg(sid.left(8));
}

QString PartyHostCore::startError() const {
  if (!active()) return QString();
  if (m_layout.seated() == 0) return tr("No party teams have joined yet");
  if (m_mode == QLatin1String("imposter") && m_layout.seated() < 6)
    return tr("An imposter game needs at least 6 seated players (%1 seated, %2 "
              "waiting for a partner)")
        .arg(m_layout.seated())
        .arg(m_layout.waiting().size());
  return QString();
}

QList<PartyHostCore::PlannedTeam> PartyHostCore::start() {
  QList<PlannedTeam> plan;
  if (!active()) return plan;
  m_seatToSid.clear();
  m_seatNames.clear();
  m_teamBase.clear();
  m_vacant.clear();
  m_imposters.clear();

  const QList<PartyTeam> &lobbyTeams = m_layout.teams();
  for (int ti = 0; ti < lobbyTeams.size(); ++ti) {
    const PartyTeam &pt = lobbyTeams.at(ti);
    PlannedTeam team;
    team.name = pt.name;
    team.paletteIndex = kPalette[ti % 4];
    const int n = m_layout.hogCount(pt);
    for (int h = 0; h < n; ++h) {
      PlannedHog hog;
      if (h < pt.members.size()) {
        hog.name = pt.members.at(h).name;
        hog.sid = pt.members.at(h).sid;
        hog.human = true;
        const int slot = ti * kSlotsPerTeam + h;
        m_seatToSid[slot] = hog.sid;
        m_seatNames[slot] = hog.name;
      }
      team.hogs.append(hog);
    }
    m_teamBase.insert(pt.name, ti * kSlotsPerTeam);
    plan.append(team);
  }

  // imposter: one secret traitor on EACH team, drawn from that team's seated
  // players
  if (m_mode == QLatin1String("imposter") && lobbyTeams.size() == 2) {
    for (int ti = 0; ti < 2; ++ti) {
      const PartyTeam &pt = lobbyTeams.at(ti);
      if (pt.members.isEmpty()) continue;
      const int pick = std::clamp(m_pick(static_cast<int>(pt.members.size())),
                                  0, static_cast<int>(pt.members.size()) - 1);
      const PartyTeam &other = lobbyTeams.at(1 - ti);
      Imposter imp;
      imp.sid = pt.members.at(pick).sid;
      imp.name = pt.members.at(pick).name;
      imp.team = pt.name;
      imp.hogIdx = pick;
      imp.cloneTeam = other.name;
      imp.cloneIdx = m_layout.hogCount(other);  // the free slot the engine uses
      m_imposters.append(imp);
    }
  }

  // players still waiting for a partner sit this game out and go first next
  // time
  m_unseated = m_layout.waiting();
  m_locked = true;
  return plan;
}

void PartyHostCore::announce() {
  for (const Imposter &imp : m_imposters) Q_EMIT notify(imp.sid, roleText(imp));
  for (const PartyMember &w : m_unseated)
    Q_EMIT notify(w.sid, tr("This game was already full of seated players: you "
                            "go first in the next lobby."));
}

PartyHostCore::TurnInfo PartyHostCore::turn(const QString &team, int hogIdx) {
  TurnInfo t;
  if (!active() || !m_locked || hogIdx < 0) return t;
  // the engine itself checks "is the traitor their team's last living hog" and
  // does nothing otherwise, so firing at every turn start needs no health feed
  for (const Imposter &imp : m_imposters)
    if (!imp.defected)
      Q_EMIT engineCommand(
          QStringLiteral("traitor %1 %2").arg(imp.hogIdx).arg(imp.team));
  // after a defection the engine put the traitor's clone in a fresh slot on the
  // surviving team: its turns belong to the traitor's phone
  QString cloneSid;
  for (const Imposter &imp : m_imposters)
    if (imp.defected && team == imp.cloneTeam && hogIdx == imp.cloneIdx)
      cloneSid = imp.sid;
  const int base = m_teamBase.value(team, -1);
  if (base < 0) return t;
  const int slot = base + hogIdx;
  t.valid = true;
  t.sid = !cloneSid.isEmpty() ? cloneSid : m_seatToSid.value(slot);
  t.vacantSkip = t.sid.isEmpty() && m_vacant.contains(slot);
  return t;
}

void PartyHostCore::traitorSwapped(const QString &fromTeam) {
  for (Imposter &imp : m_imposters) {
    if (imp.defected || imp.team != fromTeam) continue;
    imp.defected = true;
    Q_EMIT rosterNote(
        tr("Imposter %1 defected from %2").arg(imp.name, imp.team));
    return;
  }
}

void PartyHostCore::gameEnded() {
  // can run twice for one game: only the first does anything
  if (!active() || !m_locked) return;
  QStringList audience = m_seatToSid.values();
  const QList<PartyMember> carry = m_unseated;
  const QList<Imposter> revealed = m_imposters;
  for (const PartyMember &m : carry) audience << m.sid;
  // a fresh lobby; the players left unseated go first in it
  reset(m_mode, m_layout.max(), carry);
  if (revealed.isEmpty()) return;
  QStringList who;
  for (const Imposter &imp : revealed)
    who << tr("%1 (%2%3)")
               .arg(imp.name, imp.team,
                    imp.defected ? tr(", defected") : QString());
  const QString line = tr("The imposters were %1.").arg(who.join(tr(" and ")));
  QSet<QString> told;
  for (const QString &sid : audience) {
    if (told.contains(sid)) continue;
    told.insert(sid);
    Q_EMIT notify(sid, line);
  }
  Q_EMIT rosterNote(line);
}
