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

#include "pageparty.h"

#include <QClipboard>
#include <QComboBox>
#include <QGridLayout>
#include <QGroupBox>
#include <QHBoxLayout>
#include <QImage>
#include <QLabel>
#include <QLineEdit>
#include <QListWidget>
#include <QPainter>
#include <QPixmap>
#include <QPushButton>
#include <QSizePolicy>
#include <QSpinBox>
#include <QVBoxLayout>

#include "HWApplication.h"
#include "gamecfgwidget.h"
#include "qrcodegen.hpp"
#include "teamselect.h"

PageParty::PageParty(QWidget *parent) : AbstractPage(parent) { initPage(); }

QLayout *PageParty::bodyLayoutDefinition() {
  QHBoxLayout *pageLayout = new QHBoxLayout();

  QGroupBox *partyBox = new QGroupBox(this);
  partyBox->setTitle(QGroupBox::tr("Party"));
  QVBoxLayout *partyLayout = new QVBoxLayout(partyBox);

  QLabel *lblServer = new QLabel(partyBox);
  lblServer->setText(QLabel::tr("Party server:"));
  partyLayout->addWidget(lblServer);

  leServerUrl = new QLineEdit(partyBox);
  leServerUrl->setPlaceholderText(QLineEdit::tr(
      "URL of your party worker, e.g. https://party.example.com"));
  // for a development setup: HEDGEWARS_PARTY_URL pre-fills the field
  leServerUrl->setText(qEnvironmentVariable("HEDGEWARS_PARTY_URL"));
  partyLayout->addWidget(leServerUrl);

  BtnCreate = new QPushButton(partyBox);
  BtnCreate->setText(QPushButton::tr("Open party room"));
  partyLayout->addWidget(BtnCreate);

  QLabel *lblCode = new QLabel(partyBox);
  lblCode->setText(QLabel::tr("Room code:"));
  partyLayout->addWidget(lblCode);

  lblRoomCode = new QLabel(partyBox);
  lblRoomCode->setText(QStringLiteral("------"));
  QFont codeFont = lblRoomCode->font();
  codeFont.setBold(true);
  codeFont.setPointSize(codeFont.pointSize() + 6);
  codeFont.setLetterSpacing(QFont::AbsoluteSpacing, 4);
  lblRoomCode->setFont(codeFont);
  lblRoomCode->setAlignment(Qt::AlignHCenter);
  partyLayout->addWidget(lblRoomCode);

  lblJoinUrl = new QLabel(partyBox);
  lblJoinUrl->setTextInteractionFlags(Qt::TextSelectableByMouse);
  lblJoinUrl->setWordWrap(true);
  partyLayout->addWidget(lblJoinUrl);

  BtnCopyLink = new QPushButton(partyBox);
  BtnCopyLink->setText(QPushButton::tr("Copy join link"));
  partyLayout->addWidget(BtnCopyLink);

  lblQr = new QLabel(partyBox);
  lblQr->setAlignment(Qt::AlignHCenter);
  partyLayout->addWidget(lblQr);

  lblRoster = new QLabel(partyBox);
  lblRoster->setText(QLabel::tr("Players:"));
  partyLayout->addWidget(lblRoster);

  rosterList = new QListWidget(partyBox);
  rosterList->setSelectionMode(QAbstractItemView::NoSelection);
  partyLayout->addWidget(rosterList, 1);

  pageLayout->addWidget(partyBox, 1);

  QVBoxLayout *rightLayout = new QVBoxLayout();
  gameCFG = new GameCFGWidget(this);
  rightLayout->addWidget(gameCFG);
  rightLayout->setAlignment(gameCFG, Qt::AlignTop);

  QLabel *lblMode = new QLabel(this);
  lblMode->setText(QLabel::tr("Lobby style:"));
  rightLayout->addWidget(lblMode);

  cbMode = new QComboBox(this);
  //: party lobby styles; keep the tooltips in sync with PARTY_MODES.md
  cbMode->addItem(QComboBox::tr("Classic (everyone brings a team)"));
  cbMode->addItem(QComboBox::tr("Fixed lobby (CPU fills empty slots)"));
  cbMode->addItem(QComboBox::tr("Dynamic lobby (CPU only when alone)"));
  cbMode->addItem(QComboBox::tr("Teams (one hog each; 2 to 4 teams)"));
  cbMode->addItem(QComboBox::tr("Imposter (one secret traitor per team)"));
  cbMode->setItemData(
      0,
      QComboBox::tr(
          "Every phone player registers their own team; no CPU opponents."),
      Qt::ToolTipRole);
  cbMode->setItemData(
      1,
      QComboBox::tr(
          "A set number of slots; unoccupied slots are CPU teams of the chosen "
          "difficulty. Late joiners adopt a CPU team."),
      Qt::ToolTipRole);
  cbMode->setItemData(
      2,
      QComboBox::tr(
          "A CPU team appears only while exactly one player is present."),
      Qt::ToolTipRole);
  cbMode->setItemData(
      3,
      QComboBox::tr(
          "Everyone drives ONE hog, named after their screen name. Two teams "
          "up "
          "to 12 players, three up to 18, four up to 24 (Red, Blue, Yellow, "
          "Green), kept even as players come and go. A team plays with at "
          "least "
          "3 hogs; unclaimed hogs are CPU of the chosen difficulty."),
      Qt::ToolTipRole);
  cbMode->setItemData(
      4,
      QComboBox::tr(
          "Red against Blue, 6 to 12 players, one hog each. Players are seated "
          "two at a time (one per team) so the sides stay even. Each team has "
          "a "
          "secret traitor: if they end up as their team's last hog they switch "
          "sides and win with the other team."),
      Qt::ToolTipRole);
  rightLayout->addWidget(cbMode);

  lblSlots = new QLabel(this);
  lblSlots->setText(QLabel::tr("Slots:"));
  rightLayout->addWidget(lblSlots);

  sbSlots = new QSpinBox(this);
  sbSlots->setRange(1, 8);
  sbSlots->setValue(4);
  sbSlots->setWhatsThis(QSpinBox::tr(
      "Number of team slots in a fixed lobby; unoccupied slots become CPU "
      "teams"));
  rightLayout->addWidget(sbSlots);

  QLabel *lblTier = new QLabel(this);
  lblTier->setText(QLabel::tr("CPU difficulty:"));
  rightLayout->addWidget(lblTier);

  cbCpuTier = new QComboBox(this);
  //: CPU skill tiers; 1 is the strongest bot, 5 the weakest
  cbCpuTier->addItem(QComboBox::tr("Insane"));
  cbCpuTier->addItem(QComboBox::tr("Hard"));
  cbCpuTier->addItem(QComboBox::tr("Normal"));
  cbCpuTier->addItem(QComboBox::tr("Easy"));
  cbCpuTier->addItem(QComboBox::tr("Very easy"));
  cbCpuTier->setCurrentIndex(4);
  rightLayout->addWidget(cbCpuTier);

  teamsSelect = new TeamSelWidget(this);
  rightLayout->addWidget(teamsSelect);
  teamsSelect->setSizePolicy(QSizePolicy::Preferred, QSizePolicy::Expanding);

  pageLayout->addLayout(rightLayout, 1);

  return pageLayout;
}

QLayout *PageParty::footerLayoutDefinition() {
  QHBoxLayout *footerLayout = new QHBoxLayout();

  BtnStart = new QPushButton();
  BtnStart->setStyleSheet(QStringLiteral("padding: 5px 10px"));
  BtnStart->setText(QPushButton::tr("Start"));
  BtnStart->setWhatsThis(QPushButton::tr(
      "Start the party game (requires at least one party team)"));
  BtnStart->setFixedHeight(50);

  footerLayout->addStretch();
  footerLayout->addWidget(BtnStart, 0, Qt::AlignBottom);

  return footerLayout;
}

void PageParty::connectSignals() {
  connect(BtnCopyLink, &QAbstractButton::clicked, this,
          &PageParty::copyJoinLink);
  connect(cbMode, QOverload<int>::of(&QComboBox::currentIndexChanged), this,
          &PageParty::updateModeUi);
}

void PageParty::updateModeUi(int modeIndex) {
  if (modeIndex == Imposter) {
    lblSlots->setText(QLabel::tr("Max players:"));
    sbSlots->setRange(6, 12);
    sbSlots->setValue(12);
    sbSlots->setWhatsThis(
        QSpinBox::tr("Most players the imposter lobby takes (at least 6 are "
                     "needed to start; "
                     "the engine allows up to 8 hogs a team and one place "
                     "stays free for the "
                     "traitor's clone)"));
  } else if (modeIndex == Teams) {
    lblSlots->setText(QLabel::tr("Max players:"));
    sbSlots->setRange(2, 24);
    sbSlots->setValue(24);
    sbSlots->setWhatsThis(
        QSpinBox::tr("Most players the team lobby takes: 2 teams up to 12, 3 "
                     "up to 18, 4 up to 24"));
  } else {
    lblSlots->setText(QLabel::tr("Slots:"));
    sbSlots->setRange(1, 8);
    sbSlots->setValue(4);
    sbSlots->setWhatsThis(QSpinBox::tr(
        "Number of team slots in a fixed lobby; unoccupied slots become CPU "
        "teams"));
  }
}

void PageParty::copyJoinLink() {
  HWApplication::clipboard()->setText(lblJoinUrl->text());
}

void PageParty::showJoinLink(const QString &link) {
  lblJoinUrl->setText(link);
  if (link.isEmpty()) {
    lblQr->clear();
    return;
  }

  qrcodegen::QrCode qr = qrcodegen::QrCode::encodeText(
      link.toUtf8().constData(), qrcodegen::QrCode::Ecc::MEDIUM);
  const int scale = 6;
  const int border = 4;
  const int size = (qr.getSize() + 2 * border) * scale;
  QImage img(size, size, QImage::Format_RGB32);
  img.fill(0xffffffff);
  QPainter painter(&img);
  painter.setPen(Qt::NoPen);
  painter.setBrush(QColor(0x00, 0x00, 0x00));
  for (int y = -border; y < qr.getSize() + border; y++) {
    for (int x = -border; x < qr.getSize() + border; x++) {
      if (qr.getModule(x, y)) {
        painter.drawRect((x + border) * scale, (y + border) * scale, scale,
                         scale);
      }
    }
  }
  painter.end();
  lblQr->setPixmap(QPixmap::fromImage(img));
}
