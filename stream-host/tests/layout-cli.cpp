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

// layout-cli.cpp - drives frontend-qt6/partylayout.cpp from stdin so a test can
// compare it with stream-host/agent/layout.mjs operation by operation.
//
//   mode pairs|balanced <max>      (first line)
//   join <sid> <name>
//   leave <sid>
// After every operation it prints one JSON line: {"ok":bool,"snap":{...}}.
#include <QJsonDocument>
#include <QJsonObject>
#include <iostream>
#include <string>
#include <sstream>

#include "../../frontend-qt6/partylayout.h"

int main() {
  std::string line;
  PartyLayout *lay = nullptr;
  while (std::getline(std::cin, line)) {
    std::istringstream in(line);
    std::string op;
    in >> op;
    bool ok = true;
    if (op == "mode") {
      std::string m;
      int max = 0;
      in >> m >> max;
      delete lay;
      lay = new PartyLayout(m == "pairs" ? PartyLayout::Pairs : PartyLayout::Balanced, max);
    } else if (lay && op == "join") {
      std::string sid, name;
      in >> sid >> name;
      ok = lay->join(QString::fromStdString(sid), QString::fromStdString(name));
    } else if (lay && op == "leave") {
      std::string sid;
      in >> sid;
      ok = lay->leave(QString::fromStdString(sid));
    } else {
      continue;
    }
    QJsonObject out;
    out.insert(QStringLiteral("ok"), ok);
    out.insert(QStringLiteral("snap"), lay ? lay->snapshot() : QJsonObject());
    std::cout << QJsonDocument(out).toJson(QJsonDocument::Compact).toStdString() << std::endl;
  }
  delete lay;
  return 0;
}
