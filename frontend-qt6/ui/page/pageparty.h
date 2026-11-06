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

#ifndef PAGE_PARTY_H
#define PAGE_PARTY_H

#include "AbstractPage.h"

class QComboBox;
class GameCFGWidget;
class QLabel;
class QLineEdit;
class QListWidget;
class QSpinBox;
class TeamSelWidget;

class PageParty : public AbstractPage {
  Q_OBJECT

 public:
  PageParty(QWidget *parent = 0);

  void showJoinLink(const QString &link);

  QPushButton *BtnCreate;
  QPushButton *BtnStart;
  QPushButton *BtnCopyLink;
  QLineEdit *leServerUrl;
  QLabel *lblRoomCode;
  QLabel *lblJoinUrl;
  QLabel *lblQr;
  QLabel *lblRoster;
  QListWidget *rosterList;
  GameCFGWidget *gameCFG;
  TeamSelWidget *teamsSelect;
  QComboBox *cbMode;
  QSpinBox *sbSlots;
  QComboBox *cbCpuTier;

  // lobby styles, in the order of cbMode
  enum Mode { Classic = 0, Fixed, Dynamic, Teams, Imposter };
  // Team and imposter lobbies seat many players (one hog each): the spin box
  // then means "max players" instead of "slots"
  static bool isSeatMode(int modeIndex) {
    return modeIndex == Teams || modeIndex == Imposter;
  }

 protected:
  QLayout *bodyLayoutDefinition();
  QLayout *footerLayoutDefinition();
  void connectSignals();

 private Q_SLOTS:
  void copyJoinLink();
  void updateModeUi(int modeIndex);

 private:
  QLabel *lblSlots = nullptr;
};

#endif
