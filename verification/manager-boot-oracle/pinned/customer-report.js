define(
        [
            "core/class",
            "system/security",
            "system/log",
            "util/util",
            "util/message",
            "ui/ui",
            "language/language"
        ],
        function (Class, Security, Log, Util, Message, UI, Language, Pending) {
            //--------------------------------------------------------------------------

            "use strict";

            //--------------------------------------------------------------------------

            Util = new Util();
            Message = new Message();
            UI = new UI();
            Log = new Log();
            Language = new Language();

            //--------------------------------------------------------------------------

            return Class.extend({
                path: Util.apiPath + 'api/Report/',
                componentPath: "customer/report/",
                componentPathBase: "customer/",
                addInfo: {},
                buyOutKey: 'Buyout',
                //----------------------------------------------------------------------
                init: function () {
                },
                getLogonMobile: function (options) {
                    if (options.ChosenTeamID.indexOf('/') != -1) {
                        return Util.logoPath + options.LogoTeam1;
                    } else if (options.ChosenTeamID === options.Team1ID) {
                        return Util.logoPath + options.LogoTeam1;
                    } else if (options.ChosenTeamID === options.Team2ID) {
                        return Util.logoPath + options.LogoTeam2;
                    }

                },
                getDescriptionMobile: function (options) {

                    var description = '';

                    if (options.info.TotalPointsOU !== null && options.info.LegWagerType === 'L') {

                        description = options.ShortName1 + "/" + options.ShortName2;


                    } else {

                        if (options.ChosenTeamID.indexOf('/') != -1) {
                            description = options.ShortName1 + "/" + options.ShortName2;
                        }

                        if (options.ChosenTeamID === options.Team1ID) {
                            description = options.ShortName1;
                        }

                        if (options.ChosenTeamID === options.Team2ID) {
                            description = options.ShortName2;
                        }



                    }


                    return description;


                },
                getMathSing: function (options) {
                    if (options.Amount > 0) {
                        return "+";
                    } else {
                        if (options.Amount < 0) {
                            return "-";
                        } else {
                            return " ";
                        }
                    }
                },
                displaySelected: function (options) {
                    switch (options.report) {
                        case "#report-pending-wagers":
                            $("[data-list='week']").addClass("hidden");
                            $("[data-list='weekTransactions']").addClass("hidden");
                            $("[data-list='wagerTypeSelector']").removeClass("hidden");
                            break;

                        case "#report-daily-figures":
                            $("[data-list='weekTransactions']").addClass("hidden");
                            $("[data-list='wagerTypeSelector']").addClass("hidden");
                            $("[data-list='week']").removeClass("hidden");
                            break;

                        case "#report-graded-wagers":
                            $("[data-list='week']").addClass("hidden");
                            $("[data-list='wagerTypeSelector']").addClass("hidden");
                            $("[data-list='weekTransactions']").addClass("hidden");
                            break;

                        case "#report-transactions":
                            $("[data-list='week']").addClass("hidden");
                            $("[data-list='wagerTypeSelector']").addClass("hidden");
                            $("[data-list='weekTransactions']").removeClass("hidden");
                            break;
                    }
                },
                //-------------Return the wagerType name with the picks selection -----------------------------
                getTypeInfo: function (options) {
                    var type = Language.get({key: "L-435"});
                    //------------------------------------------------------------------
                    switch (options.wagerType) {
                        case "A":
                            type = Language.get({key: "L-202"});
                            break;

                        case "M":
                            type = Language.get({key: "L-432"});
                            break;
                            //----------------------------------------------------------

                        case "C":
                            type = Language.get({key: "L-203"});
                            break;
                            //----------------------------------------------------------

                        case "S":
                            type = Language.get({key: "L-142"});
                            break;
                            //----------------------------------------------------------

                        case "T":
                            type = Language.get({key: "L-85"}) + " - " + options.totalPicks + " " + Language.get({key: "L-384"});
                            break;
                            //----------------------------------------------------------

                        case "L":
                            type = Language.get({key: "L-144"});
                            break;
                            //----------------------------------------------------------

                        case "E":
                            type = Language.get({key: "L-145"});
                            break;
                            //----------------------------------------------------------

                        case "I":
                            if (options.birdCage == null && options.ARLink == null) {
                                type = Language.get({key: "L-16"}) + " - " + options.totalPicks + " " + Language.get({key: "L-384"});
                            } else {
                                if (options.birdCage == "1") {
                                    //type = "Action Reverse Box/Birdcage Item  ";
                                    type = Language.get({key: "L-433"});
                                } else {
                                    //type = "Action Reverse Item";
                                    type = Language.get({key: "L-436"});
                                }
                            }

                            break;
                        case "P":
                            type = Language.get({key: "L-15"}) + " - " + options.totalPicks + " " + Language.get({key: "L-384"});
                            break;

                            //----------------------------------------------------------

                        case "G":

                            if (options.item.PlacedOn) {
                                if (options.item.PlacedOn.toString().trim() == 'EZL - INTERNET' ||
                                        options.item.PlacedOn.toString().trim() == 'LIVEBETTINGCWS - ADMIN') {
                                    type = 'Live Wagers';
                                } else {
                                    type = 'Racebook';
                                }
                            } else {
                                if (options.item.TicketWriter.toString().trim() == 'EZL - INTERNET' ||
                                        options.item.TicketWriter.toString().trim() == 'LIVEBETTINGCWS - ADMIN') {
                                    type = 'Live Wagers';
                                } else {
                                    type = 'Racebook';
                                }

                            }




                            break;

                    }
                    //------------------------------------------------------------------
                    if (options.roundRobin > 0) {
                        type = Language.get({key: "L-434"}) + " - " + options.totalPicks + " " + Language.get({key: "L-384"});
                    }
                    //------------------------------------------------------------------
                    return type;
                },
                //Retorna el "rotation number" basado segun su "chosenId" ---------------
                getRotationNumber: function (options) {
                    if (options.Team1ID === options.ChosenTeamID) {
                        return options.Team1RotNum;
                    }
                    return options.Team2RotNum;
                },
                //Retorna la linea segÃºn el tipo de apuesta -----------------------------
                getLineGame: function (options) {

                    var defaults = {
                        TeaserPoints: 0
                    };
                    //------------------------------------------------------------------

                    var setting = $.extend(defaults, options);

                    var result = '';
                    var _self = this;
                    var moneyLine = Util.setSymbol({str: options.FinalMoney});

                    switch (options.WagerType) {
                        case "S": //Straight Bet (Spread)

                            //console.log('---SAS');

                            result = ((options.AdjSpread > 0) ? " +" : " ") + Util.isDecimal({number: options.AdjSpread}) + ((options.FinalMoney > 0) ? " +" : " ") + options.FinalMoney.toString();
                            result = Util.checkDisplayLine({sportType: options.SportType.toString().toUpperCase().trim(),
                                line: parseFloat(options.AdjSpread), odd: moneyLine,
                                lineType: Util.BET.SUB_TYPE.SPREAD.val, append: false, report: true,
                                totalOU: options.TotalPointsOU}) + ' ' + moneyLine;


                            if (parseFloat(setting.TeaserPoints) !== 0
                                    && parseFloat(setting.TeaserPoints) !== null) {

                                var spreadPoints;
                                var lineSpread;

                                //------------------------------------------------------

                                spreadPoints = parseFloat(options.AdjSpread) + parseFloat(options.TeaserPoints);

                                //------------------------------------------------------

                                lineSpread = Util.isDecimal({
                                    number: Util.setSymbol({str: spreadPoints})
                                });

                                result = lineSpread + ' ' + options.FinalMoney;

                            }



                            break;
                        case "M": //Money Lines
                            result = "<label class='moneyLineAbrv'>" + _self.getLinesML(options) + "</label>" + ((options.FinalMoney > 0) ? " + " : " ") + options.FinalMoney.toString();
                            break;
                        case "C": //Contest
                            result = ((options.FinalMoney > 0) ? " + " : " ") + options.FinalMoney.toString();
                            break;
                        case "L": //Total
                            //result = ((options.TotalPointsOU == "O") ? Language.get({ key: "L-247" }) : Language.get({ key: "L-248" })).toLowerCase() + " " + Util.isDecimal({ number: options.AdjTotalPoints }) + ((options.FinalMoney > 0) ? " +" : " ") + options.FinalMoney.toString();
                            result = options.TotalPointsOU + " " + Util.isDecimal({number: options.AdjTotalPoints}) + ((options.FinalMoney > 0) ? " +" : " ") + options.FinalMoney.toString();
                            result = Util.checkDisplayLine({sportType: options.SportType.toString().toUpperCase().trim(),
                                line: parseFloat(options.AdjTotalPoints), odd: moneyLine,
                                lineType: Util.BET.SUB_TYPE.TOTAL.val, report: true,
                                append: false, totalOU: options.TotalPointsOU}) + ' ' + moneyLine;
                            ;

                            if (parseFloat(setting.TeaserPoints) > 0) {

                                var totalPoints = 0;

                                if (options.TotalPointsOU.toString().toLowerCase() == "o") {
                                    totalPoints =
                                            parseFloat(options.AdjTotalPoints) -
                                            parseFloat(options.TeaserPoints);
                                } else {
                                    totalPoints =
                                            parseFloat(options.AdjTotalPoints) +
                                            parseFloat(options.TeaserPoints);
                                }

                                result = options.TotalPointsOU.toString() + ' ' + Util.isDecimal({number: totalPoints}) + ' ' + ((options.FinalMoney > 0) ? " +" : " ") + options.FinalMoney;

                            }



                            break;
                        case "E": //Team-Total
                            result = options.TotalPointsOU + " " + Util.isDecimal({number: options.AdjTotalPoints}) + ((options.FinalMoney > 0) ? " +" : " ") + options.FinalMoney.toString();
                            break;
                    }

                    //-----------







                    return result;
                },
                //Define el nombre del "wagerStatus" a partir de sus cÃ³digos------------
                getWagerStatus: function (options) {
                    var status = ''
                    switch (options.WagerStatus) {
                        case 'W':
                            status = Language.get({key: "L-393"});
                            break;
                        case 'X':
                            // status = Language.get({key: "L-225"});
                            status = 'Cancelled/Pushed ';
                            break;
                        case 'L':
                            status = Language.get({key: "L-222"});
                            break;
                        default:
                            status = Language.get({key: "L-233"});
                            break;
                    }
                    return status;
                },
                //----------------------------------------------------------------------
                getLinesML: function (options) {
                    var description = ''
                    if (options.SportType.toUpperCase().trim() === 'SOCCER' && options.WagerType === 'M' && options.ChosenTeamID === options.Team1ID + " / " + options.Team2ID) {
                        description = 'DRAW'
                    } else {
                        description = 'ML'
                    }
                    return description;
                },
                //------------------------------------------------------------------------ 
                getMenu: function (options) {
                    var defaults = {
                        report: "#report-pending-wagers",
                        el: $("#tab-report-1 li:nth-child(1) a")
                    };

                    var setting = $.extend(defaults, options);

                    var _customer = require("customer/customer");
                    var Customer = new _customer();

                    Customer.getAccountInfo();

                    //------------------------------------------------------------------

                    UI.getComponent({
                        func: this.setMenu,
                        component: this.componentPath + "report-menu",
                        info: {
                            self: this,
                            report: setting.report,
                            el: setting.el
                        }
                    });
                },
                //----------------------------------------------------------------------
                tabListeners: function () {
                    var _self = this;

                    //------------------------------------------------------------------

                    $('[data-menu="report"] li a').off("click").on("click", function (e) {
                        e.preventDefault();
                        //--------------------------------------------------------------
                        if (
                                $(this).closest("[data-menu]").attr("data-ajax") == Util.state.ACTIVE
                                ) {
                            UI.getComponent({
                                func: _self.setMenu,
                                component: _self.componentPath + "report-menu",
                                info: {
                                    self: _self,
                                    report: $(this).attr("href"),
                                    el: $(this)
                                }
                            });
                        } else {
                            $(this).tab("show");
                        }

                        //--------------------------------------------------------------

                        if (Util.isMobile()) {
                            Message.showNotify({
                                el: $(this),
                                class: "pop-min",
                                msg: $(this)
                                        .closest("li")
                                        .data("title"),
                                trigger: "click"
                            });

                            UI.removeElement({
                                el: $(".popover"),
                                time: 800
                            });
                        }
                    });

                    //------------------------------------------------------------------

                    $('[data-content="report"] .panel-heading').off("click").on("click", function () {
                        $(this).find("a")[0].click();
                    });
                },
                //----------------------------------------------------------------------
                setMenu: function (options) {
                    var _self = options.info.self;
                    var report = options.component.clone();

                    //------------------------------------------------------------------
                    $('[data-page="reports"] [data-content="report"]').empty();
                    //------------------------------------------------------------------
                    UI.showPage({page: $('[data-page="reports"]')});

                    //------------------------------------------------------------------

                    $('[data-page="reports"] [data-content="report"]').html(report.html());

                    //------------------------------------------------------------------

                    _self.tabListeners();

                    //------------------------------------------------------------------

                    $('[data-content="report"] .tab-pane').removeClass("active");
                    $('[data-content="report"] ')
                            .find(options.info.report)
                            .addClass("active");

                    //------------------------------------------------------------------


                    $('.ticket-help-panel').addClass('hide');

                    UI.loadWagerControlsHeader(true);
                    switch (options.info.report) {
                        case "#report-pending-wagers":
                            //------------------------------------------------------
                            _self.displaySelected({report: options.info.report});
                            UI.getComponent({
                                func: _self.setPendingWagers,
                                component: _self.componentPath + "report-pending-wagers",
                                info: {
                                    self: _self,
                                    el: options.info.el
                                }
                            });

                            $('.ticket-help-panel').removeClass('hide');

                            $('#ticket-help').off().on('change', function () {

                                $('.ticket-help').toggleClass('hide');

                            });

                            break;

                        case "#report-daily-figures":
                            //----------------------------------------------------------
                            _self.displaySelected({report: options.info.report});
                            UI.getComponent({
                                func: _self.setDailyFigures,
                                component: _self.componentPath + "report-daily-figures",
                                info: {
                                    self: _self,
                                    el: options.info.el
                                }
                            });

                            break;

                        case "#report-graded-wagers":
                            //----------------------------------------------------------

                            _self.displaySelected({report: options.info.report});
                            UI.getComponent({
                                func: _self.setGradedWagers,
                                component: _self.componentPath + "report-graded-wagers",
                                info: {
                                    self: _self,
                                    el: options.info.el
                                }
                            });

                            break;

                        case "#report-transactions":
                            //----------------------------------------------------------


                            UI.getComponent({
                                func: _self.setTransactions,
                                component: _self.componentPath + "report-transactions",
                                info: {
                                    self: _self,
                                    el: options.info.el
                                }
                            });
                            _self.displaySelected({report: options.info.report});

                            break;
                    }
                },
                //----------------------------------------------------------------------
                setPendingWagers: function (options) {
                    var component = options.component.clone();
                    var _self = options.info.self;

                    //------------------------------------------------------------------

                    $("#report-pending-wagers").html(component);

                    //------------------------------------------------------------------

                    _self.tabListeners();
                    _self.getPendingWagers();

                    options.info.el.tab("show");

                    //------------------------------------------------------------------

                    //tabUI.responsiveTabs(['xs', 'sm']);
                },
                //--------------------------------------------------------------
                checkPicksWin: function (options) {

                    var ticketNumber = options.ticketNumber;
                    var flag = false;
                    var _self = this;
                    var countWins = 0;
                    var totalPicks = 0;
                    var winAmount = 0;
                    var wagerNumber = 0;

                    //----------------------------------------------------------

                    for (var h = 0; h < options.list.length; h++) {

                        var item = options.list[h];

                        if (item.Outcome === 'W' && ticketNumber === item.TicketNumber) {

                            countWins++;
                            totalPicks = item.totalPicks;
                            winAmount = item.ToWinAmount;

                            wagerNumber = item.WagerNumber;

                            //--------------------------------------------------

                            if (_self.addInfo.ParlayBuyout === 'Y') {
                                flag = true;
                            }

                        }
                    }

                    //-----------------------------------------------------------

                    return {
                        flag: flag,
                        wins: countWins,
                        totalPicks: totalPicks,
                        ticketNumber: ticketNumber,
                        winAmount: winAmount
                    };

                },
                //----------------------------------------------------------------------
                getPendingWagers: function (options) {
                    var _self = this;
                    var _customer = require("customer/customer");
                    var dataJSON = [];
                    var Customer = new _customer();
                    var _wager = require("customer/wager/wager");
                    var Wager = new _wager();
                    var param = {customerID: Customer.ID, token: Security.token, operation: "Pending"};
                    var paramAdd = {customerID: Customer.ID, token: Security.token, operation: "getAddedInfo"};

                    var defaults = {
                        deleteWagers: false
                    };
                    var setting = $.extend(defaults, options);

                    //----------------------------------------------------------

                    if (!setting.deleteWagers) {

                        $.ajax({
                            url: this.path + paramAdd.operation,
                            cache: false,
                            data: paramAdd,
                            type: "POST",
                            async: false,
                            success: function (data) {

                                if (data.INFO.length > 0) {
                                    _self.addInfo = data.INFO[0];
                                }

                            }
                        });

                    } else {

                        param = {
                            customerID: Customer.ID,
                            token: Security.token,
                            ticketNumber: options.ticketNumber,
                            operation: "PendingDelete"
                        };

                    }

                    //------------------------------------------------------------------

                    var parent = "";

                    //------------------------------------------------------------------

                    if (Util.isMobile() || setting.deleteWagers) {
                        parent =
                                '<div data-list="wagers">' +
                                '<div class="row" data-header="headerDetails">' +
                                '<div class="col-xs-8 headerDetailsDescription"><label>' + Language.get({key: "L-207"}) + "<label></div>" +
                                '<div class="col-xs-2 headerDetailsAmounts"><label>' + Language.get({key: "L-244"}) + "</label></div>" +
                                '<div class="col-xs-2 headerDetailsAmounts"><label>' + Language.get({key: "L-245"}) + "</label></div>" +
                                "</div>" +
                                "</div>";
                    } else {
                        parent =
                                ' <div class="accordion-inner table-responsive" > ' +
                                '               <table class="table table-striped table-bordered table-hover"' +
                                '                      cellspacing="0" width="100%" data-table="0">' +
                                '                    <thead data-content="head">' +
                                "                        <tr>" +
                                '                            <th style="width:15%; text-align:center;" data-language="L-206">' + Language.get({key: "L-206"}) + "</th>" +
                                '                            <th style="width:10%; text-align:center;" data-language="L-152">' + Language.get({key: "L-152"}) + "</th>" +
                                '                            <th style="width:50%;" data-language="L-207">' + Language.get({key: "L-207"}) + "</th>" +
                                '                            <th style="text-align:right;"  data-language="L-244">' + Language.get({key: "L-244"}) + "</th>" +
                                '                            <th style="text-align:right;"  data-language="L-245">' + Language.get({key: "L-245"}) + "</th>" +
                                "                        </tr>" +
                                "                    </thead>" +
                                "                    <tfoot>" +
                                "                    <tbody>" +
                                "        </tbody>" +
                                "    </table>" +
                                "</div>";
                    }

                    //------------------------------------------------------------------

                    $.ajax({
                        url: this.path + param.operation,
                        cache: false,
                        data: param,
                        type: "POST",
                        beforeSend: function () {
                            UI.setLoad({el: $("[data-page]"), class: "big-load"});
                        },
                        success: function (data) {
                            Log.write({
                                customerID: Customer.ID,
                                description: "View Pending Plays Selected"
                            });

                            UI.removeElement({el: $('[data-page] [data-control="load"]'), time: 1});

                            //----------------------------------------------------------


                            if (data.Pending.length == 0) {
                                $("#report-pending-wagers .tab-pane").html('<p class="not-rows" data-language="L-208">' + Language.get({key: "L-208"}) + "</p>");
                            } else {
                                $("#report-pending-wagers .tab-pane").html(parent);
                            }

                            //----------------------------------------------------------

                            var risk = 0;
                            var win = 0;
                            var ticketWaggerTemp = '';


                            //----------------------------------------------------------

                            for (var i = 0; i < data.Pending.length; i++) {

                                var item = data.Pending[i];
                                var gameTicketWagger = item.TicketNumber + '-' + item.WagerNumber;
                                if (gameTicketWagger != ticketWaggerTemp) {

                                    ticketWaggerTemp = gameTicketWagger;
                                    var singleWagerType = "SMLECA";
                                    var openSpots = "";
                                    var description = "";
                                    var descriptionMobile = "";
                                    var detailsMobile = "";
                                    var freePlay = "";
                                    var flag = false;

                                    //------------------------------------------

                                    var check = false;
                                    var paramCheck = {};

                                    if (item.WagerType === 'P') {
                                        paramCheck = _self.checkPicksWin({
                                            list: data.Pending,
                                            ticketNumber: item.TicketNumber
                                        });

                                        check = paramCheck.flag;

                                    }


                                    //----------------------

                                    var param = {
                                        ticketNumber: item.TicketNumber,
                                        wagerNumber: item.WagerNumber,
                                        totalPicks: item.totalPicks,
                                        win: (item.ToWinAmount / 100).toFixed(2),
                                        risk: (item.AmountWagered / 100).toFixed(2),
                                        description: item.Description.toString().split(" ").join(Util.concat.PARAM),
                                        spotsAvailable: parseInt(item.WagerCount)
                                    };

                                    risk += parseFloat(param.risk);
                                    win += parseFloat(param.win);

                                    //------------------------------------------------------

                                    var detail = {
                                        ticketNumber: item.TicketNumber,
                                        wagerNumber: item.WagerNumber,
                                        flag: item.WagerType
                                    };

                                    //------------------------------------------------------

                                    var style = '';

                                    if (Util.isMobile() || setting.deleteWagers) {
                                        style = 'display:inline-block';
                                    }

                                    var buyOut = '';

                                    paramCheck.wagerNumber = item.WagerNumber;
                                    paramCheck.winAmount = item.ToWinAmount;

                                    if (check && !setting.deleteWagers) {
                                        buyOut = '<button data-param=' + JSON.stringify(paramCheck) + ' ' +
                                                'data-id="buy-' + item.TicketNumber + '" ' +
                                                'data-action="buyout-parlay" ' +
                                                'class="buyout-parlay" style="' + style + '">Buyout Parlay</button>';
                                    }

                                    if (Util.isMobile() || setting.deleteWagers) {

                                        var wagerDescriptionFormat = "<div class='col-md-12 col-sm-12 col-xs-12 wagerPendingMobile j1'>" +
                                                "<div class='col-md-4 col-sm-4 col-xs-4'>" +
                                                "<label class='normalDescription'>{Header}</label>" +
                                                "</div>" +
                                                "<div class='col-md-8 col-sm-8 col-xs-8 BOLA-2'>" +
                                                "<label class='normalDescription'>{Content}</label>" +
                                                "</div>" +
                                                "</div>";


                                        var wagerData = data.Pending.filter(function (el) {
                                            return el.TicketNumber == item.TicketNumber && el.WagerNumber == item.WagerNumber;
                                        });

                                        if (!singleWagerType.includes(item.WagerType)) {


                                            var commentH = '';

//                                            if (item.Comments !== null && item.Comments !== '') {
//                                                commentH = wagerDescriptionFormat.replace("{Header}", ("Game Note :")).replace("{Content}", item.Comments);
//                                            }
//                                            

                                            var rotationNumber = _self.getRotationNumber({Team1ID: item.Team1ID, ChosenTeamID: item.ChosenTeamID, Team1RotNum: item.Team1RotNum, Team2RotNum: item.Team2RotNum});
                                            var wagerType = _self.getTypeInfo({item: item, birdCage: item.ARBirdcageLink, wagerType: item.WagerType, roundRobin: item.RoundRobinLink, ARLink: item.ARLink, totalPicks: item.totalPicks});


                                            if (item.WagerType === 'T') {

                                                wagerDescriptionFormat = wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-38"}) + "#:")).replace("{Content}", "<label>" + item.TicketNumber + "</label>") +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-423"}) + ":")).replace("{Content}", _self.getWagerStatus({WagerStatus: item.WagerStatus})) +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-244"}) + "/" + Language.get({key: "L-393"}) + ":")).replace("{Content}", "<label>" + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.AmountWagered / 100}) + " / " + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.ToWinAmount / 100})) + "</label>" +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-614"}) + ":")).replace("{Content}", item.TeaserName) +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-206"}) + ":")).replace("{Content}", $.format.date(item.AcceptedDateTime.split(".")[0], "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT) +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-425"}) + ":")).replace("{Content}", item.PlacedOn) +
                                                        //((item.Comments !== '') ? wagerDescriptionFormat.replace("{Header}", ("Game Note :")).replace("{Content}", item.Comments) : '');
                                                        commentH;

                                            } else {

                                                wagerDescriptionFormat = wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-38"}) + "#:")).replace("{Content}", "<label>" + item.TicketNumber + "</label>") +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-423"}) + ":")).replace("{Content}", _self.getWagerStatus({WagerStatus: item.WagerStatus})) +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-244"}) + "/" + Language.get({key: "L-393"}) + ":")).replace("{Content}", "<label>" + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.AmountWagered / 100}) + " / " + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.ToWinAmount / 100})) + "</label>" +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-206"}) + ":")).replace("{Content}", $.format.date(item.AcceptedDateTime.split(".")[0], "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT) +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-425"}) + ":")).replace("{Content}", item.PlacedOn) +
                                                        //((item.Comments !== '') ? wagerDescriptionFormat.replace("{Header}", ("Game Note :")).replace("{Content}", item.Comments) : '');
                                                        commentH;

                                            }


                                            detailsMobile += wagerDescriptionFormat + _self.getResultTicketMobileDetails(wagerData);

                                        } else {
                                            detailsMobile += _self.getResultTicketMobileDetails(wagerData);
                                        }


                                        descriptionMobile += _self.getResultTicketMobile(wagerData);

                                        //------------------------------------------------------
                                    } else {


                                        //--------------------------------------

                                        var wagerDescriptionFormat =
                                                buyOut +
                                                "<div data-group='" + item.TicketNumber + "-" + item.WagerNumber + "' class='hidden ticketNumberDescription'>" +
                                                "<div class='col-md-12 col-sm-12 col-xs-12'>" +
                                                "<div class='col-md-3 col-sm-3 col-xs-3 z1'>" +
                                                "<label class='normalDescription'>{Header}</label>" +
                                                "</div>" +
                                                "<div class='col-md-9 col-sm-9 col-xs-9'>" +
                                                "<label class='normalDescription'>{Content}</label>" +
                                                "</div>" +
                                                "</div>" +
                                                "</div>";

                                        var rotationNumber = _self.getRotationNumber({Team1ID: item.Team1ID, ChosenTeamID: item.ChosenTeamID, Team1RotNum: item.Team1RotNum, Team2RotNum: item.Team2RotNum});
                                        var wagerType = (item.WagerType === "C" || item.WagerType === "A" ? "" : _self.getTypeInfo({item: item, birdCage: item.ARBirdcageLink, wagerType: item.WagerType, roundRobin: item.RoundRobinLink, ARLink: item.ARLink, totalPicks: item.totalPicks}));

                                        if (!singleWagerType.includes(item.WagerType)) {


                                            var commentH = '';

//                                            if (item.Comments !== null && item.Comments !== '') {
//                                                commentH = wagerDescriptionFormat.replace("{Header}", ("Game Note :")).replace("{Content}", item.Comments);
//                                            }


                                            var game = (item.WagerType === 'C') ? item.Team2ID : item.Team1ID + ' / ' + item.Team2ID;


                                            if (item.WagerType === 'T') {

                                                description += wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-38"}) + "#:")).replace("{Content}", "<label>" + item.TicketNumber + "</label>") +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-423"}) + ":")).replace("{Content}", _self.getWagerStatus({WagerStatus: item.WagerStatus})) +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-244"}) + "/" + Language.get({key: "L-393"}) + ":")).replace("{Content}", "<label>" + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.AmountWagered / 100}) + " / " + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.ToWinAmount / 100})) + "</label>" +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-614"}) + ":")).replace("{Content}", item.TeaserName) +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-206"}) + ":")).replace("{Content}", $.format.date(item.AcceptedDateTime.split(".")[0], "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT) +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-425"}) + ":")).replace("{Content}", item.PlacedOn) +
                                                        //((item.Comments !== '') ? wagerDescriptionFormat.replace("{Header}", ("Game Note :")).replace("{Content}", item.Comments) : '');
                                                        commentH;

                                            } else {

                                                description += wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-38"}) + "#:")).replace("{Content}", "<label>" + item.TicketNumber + "</label>") +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-423"}) + ":")).replace("{Content}", _self.getWagerStatus({WagerStatus: item.WagerStatus})) +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-244"}) + "/" + Language.get({key: "L-393"}) + ":")).replace("{Content}", "<label>" + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.AmountWagered / 100}) + " / " + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.ToWinAmount / 100})) + "</label>" +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-206"}) + ":")).replace("{Content}", $.format.date(item.AcceptedDateTime.split(".")[0], "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT) +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-425"}) + ":")).replace("{Content}", item.PlacedOn) +
                                                        //((item.Comments !== '') ? wagerDescriptionFormat.replace("{Header}", ("Game Note :")).replace("{Content}", item.Comments) : '');
                                                        commentH;

                                            }

                                            //-------- Carga la informacion de los juegos --------//    

                                            var wagerData = data.Pending.filter(function (el) {
                                                return el.TicketNumber == item.TicketNumber && el.WagerNumber == item.WagerNumber;
                                            });

                                            description += _self.getResultTicketPending(wagerData);

                                        } else {

                                            //-------- Carga la informacion de los juegos --------//    

                                            var wagerData = data.Pending.filter(function (el) {
                                                return el.TicketNumber == item.TicketNumber && el.WagerNumber == item.WagerNumber;
                                            });
                                            description += _self.getResultTicketPending(wagerData);


                                            var game = (item.WagerType === 'C') ? item.Team2ID : item.Team1ID + ' / ' + item.Team2ID;

                                            var commentH = '';

                                            if (item.Comments !== null && item.Comments !== '') {
                                                commentH = wagerDescriptionFormat.replace("{Header}", ("Game Note :")).replace("{Content}", item.Comments);
                                            }

                                            if (item.WagerType === 'C' || item.WagerType === 'A') {

                                                if (item.WagerType === 'A') {
                                                    game = '';
                                                }

                                                description += wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-38"}) + "#:")).replace("{Content}", "<label>" + item.TicketNumber + "</label>") +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-423"}) + ":")).replace("{Content}", _self.getWagerStatus({WagerStatus: item.WagerStatus})) +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-244"}) + "/" + Language.get({key: "L-393"}) + ":")).replace("{Content}", "<label>" + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.AmountWagered / 100}) + " / " + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.ToWinAmount / 100})) + "</label>" +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-237"}) + ":")).replace("{Content}", game) +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-426"}) + ":")).replace("{Content}", $.format.date(item.GameDateTime.split(".")[0], "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT) +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-206"}) + ":")).replace("{Content}", $.format.date(item.AcceptedDateTime.split(".")[0], "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT) +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-425"}) + ":")).replace("{Content}", item.PlacedOn) +
                                                        //((item.Comments !== '') ? wagerDescriptionFormat.replace("{Header}", ("Game Note :")).replace("{Content}", item.Comments) : '');
                                                        commentH;
                                            } else {

                                                if (item.WagerType === 'G') {

                                                    description += wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-423"}) + ":")).replace("{Content}", _self.getWagerStatus({WagerStatus: item.WagerStatus})) +
                                                            wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-244"}) + "/" + Language.get({key: "L-393"}) + ":")).replace("{Content}", "<label>" + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.AmountWagered / 100}) + " / " + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.ToWinAmount / 100})) + "</label>" +
                                                            wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-237"}) + ":")).replace("{Content}", game) +
                                                            wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-424"}) + ":")).replace("{Content}", ((item.WagerType === 'L') ? item.Team1RotNum + '/' + item.Team2RotNum : rotationNumber) + "   " + item.PeriodDescription.trim() + " " + wagerType) +
                                                            wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-426"}) + ":")).replace("{Content}", $.format.date(item.GameDateTime.split(".")[0], "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT) +
                                                            wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-206"}) + ":")).replace("{Content}", $.format.date(item.AcceptedDateTime.split(".")[0], "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT) +
                                                            wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-425"}) + ":")).replace("{Content}", item.PlacedOn) +
                                                            //((item.Comments !== '') ? wagerDescriptionFormat.replace("{Header}", ("Game Note :")).replace("{Content}", item.Comments) : '');
                                                            commentH;
                                                } else {

                                                    var pitcher = '';

                                                    switch (item.SportType.toString().toUpperCase().trim()) {

                                                        case Util.SPORT.BASEBALL:

                                                            if (item.ListedPitcher1 !== null) {

                                                                pitcher = '<br><div class="pitcher-pending">( ' +
                                                                        item.ListedPitcher1 + ' ' + Util.pitcherAction({type: item.Pitcher1ReqFlag}) + ' / ' +
                                                                        item.ListedPitcher2 + ' ' + Util.pitcherAction({type: item.Pitcher2ReqFlag}) + ' )</div>';
                                                            }

                                                            break;
                                                    }

//                                                    if (item.PeriodNumber > 0) {
//
//                                                        pitcher + ' - ' + item.PeriodDescription.toString().trim() + ' - ';
//
//                                                    }

                                                    var commentH = '';

                                                    if (item.Comments !== null && item.Comments !== '') {
                                                        commentH = wagerDescriptionFormat.replace("{Header}", ("Game Note :")).replace("{Content}", item.Comments);
                                                    }

                                                    description += wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-38"}) + "#:")).replace("{Content}", "<label>" + item.TicketNumber + "</label>") +
                                                            wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-423"}) + ":")).replace("{Content}", _self.getWagerStatus({WagerStatus: item.WagerStatus})) +
                                                            wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-244"}) + "/" + Language.get({key: "L-393"}) + ":")).replace("{Content}", "<label>" + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.AmountWagered / 100}) + " / " + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.ToWinAmount / 100})) + "</label>" +
                                                            wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-237"}) + ":")).replace("{Content}", game) +
                                                            wagerDescriptionFormat.replace("{Header}",
                                                                    (Language.get({key: "L-424"}) + ":")).replace("{Content}",
                                                            item.SportSubType + ' ' + ((item.WagerType === 'L') ? item.Team1RotNum + '/' +
                                                                    item.Team2RotNum : rotationNumber) + "   " +
                                                            item.PeriodDescription.trim() + " " + wagerType + pitcher) +
                                                            wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-426"}) + ":")).replace("{Content}", $.format.date(item.GameDateTime.split(".")[0], "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT) +
                                                            wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-206"}) + ":")).replace("{Content}", $.format.date(item.AcceptedDateTime.split(".")[0], "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT) +
                                                            wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-425"}) + ":")).replace("{Content}", item.PlacedOn) +
                                                            //((item.Comments !== '') ? wagerDescriptionFormat.replace("{Header}", ("Game Note :")).replace("{Content}", item.Comments) : '');
                                                            commentH;
                                                }



                                            }


                                        }

                                    }


                                    if (data.Pending[i].WagerStatus == Util.status.OPEN) {
                                        openSpots = " <button " + 'data-action="open-spots" ' + "data-param=" + JSON.stringify(param) + ' data-type="' + data.Pending[i].WagerType + '" ' + 'class="btn btn-info btn-sm" >' + "( " + data.Pending[i].WagerCount + " ) " + (Util.isMobile() ? Language.get({key: "L-418"}) : Language.get({key: "L-68"})) + "</button>";
                                    }

                                    //------------------------------------------------------

                                    if (item.FreePlayFlag == "Y") {
                                        freePlay = '<span class="label label-primary freeplaySpan">' + Language.get({key: 'L-419'}) + '</span>';
                                    }

                                    //------------------------------------------------------

                                    var element = "";
                                    var footer = "";

                                    if (Util.isMobile() || setting.deleteWagers) {

                                        if (item.FreePlayFlag == "Y") {
                                            freePlay = '<span style=" color: white; margin: 0px 2px; " class="label label-primary freeplaySpan">' + Language.get({key: 'L-419'}) + '</span>';
                                        }

                                        var type = (singleWagerType.includes(item.WagerType)) ? "" : _self.getTypeInfo({item: item, birdCage: data.Pending[i].ARBirdcageLink, wagerType: data.Pending[i].WagerType, roundRobin: data.Pending[i].RoundRobinLink, ARLink: data.Pending[i].ARLink, totalPicks: data.Pending[i].totalPicks})
                                        //var title = (type != '') ? '<label class="normalDescription">' + type + '</label>' + openSpots + '</br>' : '<b>' + openSpots + '</b>';
                                        var title = (type != '') ? type + openSpots + '</br>' : '<b>' + openSpots + '</b>';

                                        if (item.WagerType === 'A') {
                                            title = '';
                                        }

                                        element =
                                                '<div class="row headerWager"  data-action="show-ticket-detail" data-ticket=' + item.TicketNumber + '-' + item.WagerNumber + ">" +
                                                '<div class="detailsHeaderWagerMobile">' +
                                                '<div class="col-xs-7 detailsWagerMobile size-a">' + title + descriptionMobile + "</div>" +
                                                '<div class="col-xs-2 detailsWagerMobileRisk" data-risk=' + param.risk + '>' +
                                                freePlay + '<span  class="value-Risk Castle">' + Util.getCurrency(Customer.accountInfo.CurrencyCode) + Util.formatCurrency({val: param.risk, decimal: false}) + "</span>" +
                                                "</div>" +
                                                '<div class="col-xs-2 detailsWagerMobileWin" data-win=' + param.win + '>' +
                                                '<span  class="value">' + Util.getCurrency(Customer.accountInfo.CurrencyCode) + Util.formatCurrency({val: param.win, decimal: false}) + "</span>" +
                                                "</div>" +
                                                buyOut +
                                                '</div>' +
                                                '<div class="detailsBodyWagerMobile hidden" data-details="detailsWagger" data-group=' + item.TicketNumber + '-' + item.WagerNumber + ">" +
                                                detailsMobile +
                                                "</div>" +
                                                "</div>";






                                        //--------------------------------------------------

                                        $('[data-type="all"] [data-list="wagers"]').append(element);
                                        $('[data-type*="' + data.Pending[i].WagerType + '"] [data-list="wagers"]').append(element);

                                        $('b:empty').remove();

                                    } else {
                                        element =
                                                '<tr class="header" data-ticket=' + item.TicketNumber + '-' + item.WagerNumber + '>' +
                                                '<td class="tableColumnFixed leftAlign"><span>' + $.format.date(item.AcceptedDateTime.split(".")[0], "E M/d hh:mm a") + "</span></br>" +
                                                "<span class='hide ticket-help'>Ticket #" + item.TicketNumber + "</span>" + openSpots + "</td>" +
                                                '<td class="tableColumnFixed leftAlign">' + _self.getTypeInfo({item: item, birdCage: data.Pending[i].ARBirdcageLink, wagerType: data.Pending[i].WagerType, roundRobin: data.Pending[i].RoundRobinLink, ARLink: data.Pending[i].ARLink, totalPicks: data.Pending[i].totalPicks}) + "</td>" +
                                                '<td class="tableColumnFixed leftAlign">' + description + "</td> " +
                                                '<td style="width: 160px;color: red;text-align:right;" data-risk="' + param.risk + '">' + freePlay + Util.getCurrency(Customer.accountInfo.CurrencyCode) + Util.formatCurrency({val: param.risk}) + "</td>" +
                                                '<td style="width: 160px;text-align:right;" data-win="' + param.win + '">' + Util.getCurrency(Customer.accountInfo.CurrencyCode) + Util.formatCurrency({val: param.win}) + "</td> " +
                                                "</tr>";

                                        //--------------------------------------------------

                                        $('[data-type="all"] table tbody').append(element);
                                        $('[data-type*="' + data.Pending[i].WagerType + '"] table tbody').append(element);

                                        $('b:empty').remove();
                                    }

                                    //------------------------------------------------------
                                }

                            }

                            //----------------------------------------------------------

                            _self.listeners();

                            //----------------------------------------------------------


                            //----------------------------------------------------------

                            _self.setTotals(data);

                            if (setting.deleteWagers) {
                                $('[data-modal="ticket-detail"]').modal('show');
                            }
                        }
                    });
                },
                //----------------------------------------------------------------------
                setTotals: function (data) {
                    var content = $("#report-pending-wagers");
                    var risk = 0;
                    var win = 0;

                    var _customer = require("customer/customer");
                    var Customer = new _customer();
                    var ticketWaggerTemp = '';

                    //------------------------------------------------------------------


                    if (Util.isMobile()) {

                        content.find("[data-list='wagers']").each(function () {

                            if ($(this).find("div").length > 0) {

                                $(this).find("[data-risk]").each(function () {
                                    risk += parseFloat($(this).attr("data-risk"));
                                });

                                $(this).find("[data-win]").each(function () {
                                    win += parseFloat($(this).attr("data-win"));
                                });


                                var element =
                                        '<div class="row" data-action="show-ticket-detail">' +
                                        '<div class="col-xs-7 detailsWagerMobile size-b">' +
                                        '<label>' + Language.get({key: "L-417"}) + '</label>' +
                                        "</div>" +
                                        '<div class="col-xs-2 detailsWagerMobileRisk">' +
                                        '<span  class="value-Risk"><b>' + Util.getCurrency(Customer.accountInfo.CurrencyCode) + Util.formatCurrency({val: risk, decimal: false}) + "</b></span>" +
                                        "</div>" +
                                        '<div class="col-xs-2 detailsWagerMobileWin">' +
                                        '<span  class="value"><b>' + Util.getCurrency(Customer.accountInfo.CurrencyCode) + Util.formatCurrency({val: win, decimal: false}) + "</b></span>" +
                                        "</div>" +
                                        "</div>"


                                //--------------------------------------------------

                                $(this).append(element);

                                risk = 0;
                                win = 0;

                            } else {
                                $(this).html('<p class="not-rows" data-language="L-208">' + Language.get({key: "L-208"}) + "</p>");
                            }

                        });


                    } else {

                        content.find("table tbody").each(function () {

                            if ($(this).find("tr").length > 0) {

                                $(this).find("[data-risk]").each(function () {
                                    risk += parseFloat($(this).attr("data-risk"));
                                });

                                //----------------------------------------------------------

                                $(this).find("[data-win]").each(function () {
                                    win += parseFloat($(this).attr("data-win"));
                                });

                                //----------------------------------------------------------

                                var el =
                                        "<tr>" +
                                        "<td></td>" +
                                        "<td></td>" +
                                        "<td style='text-align:right;'><b>" + Language.get({key: "L-417"}) + "</b></td> " +
                                        '<td style="text-align:right; color: red;"><b>' + Util.getCurrency(Customer.accountInfo.CurrencyCode) + Util.formatCurrency({val: risk}) + "</b></td> " +
                                        '<td style="text-align:right;"><label>' + Util.getCurrency(Customer.accountInfo.CurrencyCode) + Util.formatCurrency({val: win}) + "<label></td> " +
                                        "</tr>";

                                $(this).append(el);

                                //----------------------------------------------------------

                                risk = 0;
                                win = 0;
                            } else {
                                $(this).html('<p class="not-rows" data-language="L-208">' + Language.get({key: "L-208"}) + "</p>");
                            }
                        });

                    }
                },
                //----------------------------------------------------------------------
                setDailyFigures: function (options) {
                    var component = options.component.clone();
                    var _self = options.info.self;

                    //------------------------------------------------------------------

                    var _customer = require("customer/customer");
                    var Customer = new _customer();

                    //------------------------------------------------------------------

                    $("#report-daily-figures").html(component);

                    //------------------------------------------------------------------

                    var list = $('[data-menu="report"] [data-list="week"]');
                    var msg = $('[data-field="message-week"]');

                    //------------------------------------------------------------------

                    //if (Util.isMobile()) {

                    list.append("<option value='0' data-language='L-192'>" + Language.get({key: "L-192"}) + "</option>");

                    list.append('<option value="1" >' + Language.get({key: "L-193"}) + '</option>');
                    //}

                    //------------------------------------------------------------------

                    var countWeeks = 12;
                    if (Customer.accountInfo.ShowHowManyWeeks > 0) {
                        countWeeks = Customer.accountInfo.ShowHowManyWeeks;
                    }


                    for (var i = 2; i <= countWeeks; i++) {
                        list.append("<option value=" + i + " >" + i + " " + Language.get({key: "L-209"}) + "</option>");
                    }

                    //------------------------------------------------------------------

                    list.off("change").on("change", function () {
                        //--------------------------------------------------------------
                        $(".popover.pop-min").popover('destroy');
                        if (
                                Customer.accountInfo.ShowHowManyWeeks < $(this).val() &&
                                Customer.accountInfo.ShowHowManyWeeks > 0
                                ) {
                            Message.showMsg({
                                title: Language.get({key: "L-23"}),
                                text: Language.get({key: "L-210"}),
                                icon: Message.type.INFORMATION.icon,
                                time: 2500
                            });
                        } else {
                            _self.getDailyFigures({
                                week: $(this).val(),
                                date: moment(Customer.SERVER_DATE)
                                        .subtract($(this).val(), "week")
                                        .toDate()
                            });

                            //----------------------------------------------------------

                            msg.html($(this).val() + " " + Language.get({
                                key: "L-211"
                            }));
                        }
                    });

                    //------------------------------------------------------------------

                    $('[data-action="get-daily-figures"]').off("click").on("click", function () {
                        if (Customer.accountInfo.ShowHowManyWeeks < $(this).data("week") && Customer.accountInfo.ShowHowManyWeeks > 0) {
                            Message.showMsg({
                                title: Language.get({key: "L-23"}),
                                text: Language.get({key: "L-210"}),
                                icon: Message.type.INFORMATION.icon,
                                time: 2500
                            });
                        } else {
                            if ($(this).data("week") > 0) {
                                //------------------------------------------------------

                                _self.getDailyFigures({
                                    week: $(this).data("week"),
                                    date: moment(Customer.SERVER_DATE)
                                            .subtract($(this).data("week"), "week")
                                            .toDate()
                                });
                            } else {
                                _self.getDailyFigures({
                                    week: $(this).data("week"),
                                    date: Customer.SERVER_DATE
                                });
                            }

                            //----------------------------------------------------------

                            var str = "";

                            if ($(this).data("week") < 2) {
                                str = " ";
                            }

                            //----------------------------------------------------------

                            msg.html($(this).text() + " " + str + " " + Language.get({key: "L-212"}));
                        }
                    });

                    //------------------------------------------------------------------

                    var date = Customer.SERVER_DATE;
                    var now = moment(Customer.SERVER_DATE);
                    var day = now.day();

//                    if (Customer.accountInfo.StartOfWeek == "1" && day == 1) {
//                        date = moment(date)
//                                .add(1, "day")
//                                .toDate();
//                    }

                    //------------------------------------------------------------------

                    //list.selectpicker();
                    _self.getDailyFigures({
                        week: 0,
                        date: date
                    });

                    //------------------------------------------------------------------

                    options.info.el.tab("show");

                    //------------------------------------------------------------------

                    //tabUI.responsiveTabs(['xs', 'sm']);
                },
                //----------------------------------------------------------------------
                getDailyFigures: function (options) {
                    var _self = this;
                    var _customer = require("customer/customer");
                    var Customer = new _customer();
                    var content = $('[data-component="report-daily-figures"]');
                    var mainDate = options.date;

                    //------------------------------------------------------------------

                    var param = {
                        agentID: Customer.accountInfo.AgentID,
                        customerID: Customer.ID,
                        week: options.week,
                        token: Security.token,
                        operation: "getDailyFiguresByCustomer"
                    };

                    //------------------------------------------------------------------

                    $.ajax({
                        url: this.path + param.operation,
                        cache: false,
                        data: param,
                        type: "POST",
                        beforeSend: function () {
                            UI.setLoad({el: $("[data-page]"), class: "big-load"});
                        },
                        success: function (data) {
                            UI.removeElement({el: $('[data-page] [data-control="load"]'), time: 1});

                            Log.write({
                                customerID: Customer.ID,
                                description: "View Daily Figures"
                            });

                            //----------------------------------------------------------

                            var closeDay = 1;
                            var now = moment(Customer.SERVER_DATE);
                            var day = now.day();

                            //----------------------------------------------------------
//
//                            if (Customer.accountInfo.StartOfWeek == '1' && moment(new Date()).format('d') == '1') {
//
//                                mainDate = moment(mainDate).subtract(1, 'week').toDate();
//
//                            }

                            if (Customer.accountInfo.StartOfWeek == "1") {
//                                if (day == 1) {
//                                    mainDate = moment(mainDate)
//                                            .subtract(1, "week")
//                                            .toDate();
//                                } else {
//                                    mainDate = moment(mainDate).toDate();
//                                }

                                closeDay = 2;
                            }

                            //----------------------------------------------------------

                            var item = data.INFO;
                            var days = "";
//                            var starWeek = Util.getStartWeek({
//                                date: mainDate,
//                                closeDay: closeDay
//                            });
//                            var month = Util.month[mainDate.getMonth()];


                            var starWeek = moment(mainDate).isoWeekday(closeDay);

                            if (Customer.accountInfo.StartOfWeek == '1' && moment(Customer.SERVER_DATE).day() === 1) {
                                starWeek = moment(mainDate).subtract(6, 'day').toDate();
                            }

                            var month = Util.month[moment(mainDate).toDate().getMonth()];

                            //----------------------------------------------------------

                            var date = starWeek;
                            var fecha = "";
                            $('[data-panel="wagers-daily-figure"]').empty();

                            //----------------------------------------------------------

                            var titles = [];
                            var figureDay = [];

                            if (item.figuredays != null) {
                                figureDay = item.figuredays.toString().trim();
                                figureDay = figureDay.split(",");
                            }


                            //----------------------------------------------------------

                            for (var i = 0; i < 7; i++) {
                                var day = Util.addDays({date: date, days: i}).getDate();
                                month = Util.month[Util.addDays({date: date, days: i}).getMonth()];

                                //var title = month + ' ' + day + ' ' + Util.specialDay[i];
                                var title = Util.specialDay[i] + "(" + (Util.addDays({date: date, days: i}).getMonth() + 1) + "/" + day + ")";

                                //------------------------------------------------------

                                if (Customer.accountInfo.StartOfWeek == "1") {
                                    // Close Day Tuesday

                                    title = Util.specialDay[i] + "(" + (Util.addDays({date: date, days: i}).getMonth() + 1) + "/" + day + ")";
                                    days += '<th data-graded="false" data-date="' + Util.addDays({date: date, days: i}) + '">' + title + "</th>";

                                } else {
                                    //title = month + ' ' + day + ' ' + Util.day[i];
                                    title = Util.day[i] + "(" + (Util.addDays({date: date, days: i}).getMonth() + 1) + "/" + day + ")";
                                    days += '<th data-graded="false" data-date="' + Util.addDays({date: date, days: i}) + '">' + title + "</th>";
                                    fecha = Util.addDays({date: date, days: i});
                                }

                                //------------------------------------------------------

                                titles.push({
                                    title: title,
                                    figure: figureDay,
                                    date: fecha
                                });
                            }

                            //----------------------------------------------------------

                            var header =
                                    '<th class="hidden" data-language="L-213">' + Language.get({key: "L-213"}) + "</th>" +
                                    '<th data-language="L-215">' + Language.get({key: "L-215"}) + "</th> " + days +
                                    '<th data-language="L-216" data-graded="true" data-date="' + Util.addDays({date: date, days: 0}) + '" >' + Language.get({key: "L-216"}) + "</th>" +
                                    '<th data-language="L-420">' + Language.get({key: "L-420"}) + "</th>" +
                                    '<th class="end-balance-col" data-language="L-218">' + Language.get({key: "L-218"}) + "</th>";

                            content.find('[data-table="daily-figure"] thead tr').html(header);

                            //----------------------------------------------------------

                            var previousBalance = 0;

                            if (Customer.accountInfo.ZeroBalanceFlag != "Y") {
                                previousBalance = item.PreviousBalance;
                            }

                            var totalWeek =
                                    parseFloat(item.day1) +
                                    parseFloat(item.day2) +
                                    parseFloat(item.day3) +
                                    parseFloat(item.day4) +
                                    parseFloat(item.day5) +
                                    parseFloat(item.day6) +
                                    parseFloat(item.day7);

                            //----------------------------------------------------------

                            var balanceFinal = item.ActualBalance;
                            var casinoDaily = 0;

                            if (Customer.accountInfo.casinoDaily !== null) {

                                casinoDaily = Customer.accountInfo.casinoDaily / 100;

                            }

//                            if (casinoDaily < 0) {
//                                balanceFinal = balanceFinal + casinoDaily;
//                            } else {
//                                balanceFinal = balanceFinal - casinoDaily;
//                            }



                            var el =
                                    '<tr class="row-h">' +
                                    '<td class="hidden"><span class="responsive-field" data-language="L-213"></span>' + item.CustomerID + "</td>" +
                                    '<td><span class="responsive-field" data-language="L-215"></span>' + _self.drawWinLoss({val: previousBalance}) + "</td>" +
                                    '<td data-day="' + titles[0].title.replace("(", "").replace(")", "").replace("/", "-") + '" data-param ="' + moment(titles[0].date).format("YYYY-MM-DD") + '"><span class="responsive-field" >' + titles[0].title + "</span>" + _self.drawWinLoss({val: item.day1, trigger: true, index: 3, figure: figureDay, day: _self.getDay(1)}) + "</td>" +
                                    '<td data-group="' + titles[0].title.replace("(", "").replace(")", "").replace("/", "-") + '" class="hide detailWager"></td>' +
                                    '<td data-day="' + titles[1].title.replace("(", "").replace(")", "").replace("/", "-") + '" data-param ="' + moment(titles[1].date).format("YYYY-MM-DD") + '"><span class="responsive-field" >' + titles[1].title + "</span>" + _self.drawWinLoss({val: item.day2, trigger: true, index: 4, figure: figureDay, day: _self.getDay(2)}) + "</td>" +
                                    '<td data-group="' + titles[1].title.replace("(", "").replace(")", "").replace("/", "-") + '" class="hide detailWager"></td>' +
                                    '<td data-day="' + titles[2].title.replace("(", "").replace(")", "").replace("/", "-") + '" data-param ="' + moment(titles[2].date).format("YYYY-MM-DD") + '"><span class="responsive-field" >' + titles[2].title + "</span>" + _self.drawWinLoss({val: item.day3, trigger: true, index: 5, figure: figureDay, day: _self.getDay(3)}) + "</td>" +
                                    '<td data-group="' + titles[2].title.replace("(", "").replace(")", "").replace("/", "-") + '" class="hide detailWager"></td>' +
                                    '<td data-day="' + titles[3].title.replace("(", "").replace(")", "").replace("/", "-") + '" data-param ="' + moment(titles[3].date).format("YYYY-MM-DD") + '"><span class="responsive-field" >' + titles[3].title + "</span>" + _self.drawWinLoss({val: item.day4, trigger: true, index: 6, figure: figureDay, day: _self.getDay(4)}) + "</td>" +
                                    '<td data-group="' + titles[3].title.replace("(", "").replace(")", "").replace("/", "-") + '" class="hide detailWager"></td>' +
                                    '<td data-day="' + titles[4].title.replace("(", "").replace(")", "").replace("/", "-") + '" data-param ="' + moment(titles[4].date).format("YYYY-MM-DD") + '"><span class="responsive-field" >' + titles[4].title + "</span>" + _self.drawWinLoss({val: item.day5, trigger: true, index: 7, figure: figureDay, day: _self.getDay(5)}) + "</td>" +
                                    '<td data-group="' + titles[4].title.replace("(", "").replace(")", "").replace("/", "-") + '" class="hide detailWager"></td>' +
                                    '<td data-day="' + titles[5].title.replace("(", "").replace(")", "").replace("/", "-") + '" data-param ="' + moment(titles[5].date).format("YYYY-MM-DD") + '"><span class="responsive-field" >' + titles[5].title + "</span>" + _self.drawWinLoss({val: item.day6, trigger: true, index: 8, figure: figureDay, day: _self.getDay(6)}) + "</td>" +
                                    '<td data-group="' + titles[5].title.replace("(", "").replace(")", "").replace("/", "-") + '" class="hide detailWager"></td>' +
                                    '<td data-day="' + titles[6].title.replace("(", "").replace(")", "").replace("/", "-") + '" data-param ="' + moment(titles[6].date).format("YYYY-MM-DD") + '"><span class="responsive-field" >' + titles[6].title + "</span>" + _self.drawWinLoss({val: item.day7, trigger: true, index: 9, figure: figureDay, day: _self.getDay(0)}) + "</td>" +
                                    '<td data-group="' + titles[6].title.replace("(", "").replace(")", "").replace("/", "-") + '" class="hide detailWager"></td>' +
                                    '<td><span class="responsive-field" data-language="L-216"></span>' + _self.drawWinLoss({val: totalWeek, trigger: true, index: 10}) + "</td>" +
                                    '<td><span class="responsive-field" data-language="L-420"></span>' + _self.drawWinLoss({val: item.DepWith, trigger: true, index: 11}) + "</td>" +
                                    '<td class="end-balance-col"><span class="responsive-field" data-language="L-218"></span>' + _self.drawWinLoss({val: balanceFinal}) + "</td>" +
                                    "</tr>";

                            //----------------------------------------------------------

                            $('[data-table="daily-figure"] tbody').html(el);

                            //----------------------------------------------------------

                            Language.reload({
                                el: $('[data-table="daily-figure"] tbody')
                            });

                            //----------------------------------------------------------


                            if (Util.isMobile()) {

                                if (Customer.accountInfo.ZeroBalanceFlag === 'Y' &&
                                        parseInt($('#tab-report-1 [data-list="week"]').val()) > 1) {
                                    $('.end-balance-col').addClass('hide');
                                }
                            } else {

                                if (Customer.accountInfo.ZeroBalanceFlag === 'Y' &&
                                        parseInt($('#tab-report-2 [data-list="week"]').val()) > 1) {
                                    $('.end-balance-col').addClass('hide');
                                }
                            }


                            //----------------------------------------------------------


                            content.find('tbody [data-trigger="true"]').on("click", function () {

//                                var me = $(this);
//                                $(this).prop('disabled', true);
//
//
//                                setTimeout(function () {
//                                    me.prop('disabled', false);
//
//
//                                }, 3000);


                                var $th = $(this).closest('table').find('th').eq($(this).data('index') - 1);

                                if (Util.isMobile()) {
                                    _self.getWagersByFigureDateMobile({figureDate: moment($th.data('date')).format('YYYY-MM-DD'), graded: $th.data('graded'), el: $(this)});
                                } else {
                                    _self.getWagersByFigureDate({figureDate: moment($th.data('date')).format('YYYY-MM-DD'), graded: $th.data('graded')});
                                    $(".popover.pop-min").popover('destroy');
                                    //------------------------------------------------------

                                    Message.showNotify({
                                        msg: Language.get({key: 'L-219'}),
                                        position: 'bottom',
                                        el: $(this),
                                        trigger: 'click',
                                        class: 'pop-min'
                                    });
                                }

                                //------------------------------------------------------


                            });





                        }
                    });
                },
                //--------------------------------------------------------------
                getDay: function (day) {

                    var dayFix = day;
                    var _customer = require("customer/customer");
                    var Customer = new _customer();

                    if (Customer.accountInfo.StartOfWeek === 1) {

                        if (dayFix === 6) {
                            dayFix === 0;
                        } else {
                            dayFix = dayFix + 1;

                        }

                    }

                    return dayFix;

                },
                //----------------------------------------------------------------------
                setGradedWagers: function (options) {
                    var component = options.component.clone();
                    var _self = options.info.self;

                    //------------------------------------------------------------------

                    var _customer = require("customer/customer");
                    var Customer = new _customer();

                    //------------------------------------------------------------------

                    $("#report-graded-wagers").html(component);

                    //------------------------------------------------------------------

                    var list = $(
                            '[data-component="report-graded-wagers"] [data-list="week"]'
                            );
                    var msg = $('[data-field="message-week"]');

                    //------------------------------------------------------------------

                    if (Util.isMobile()) {
                        list.append("<option value='0' data-language='L-192'>" + Language.get({key: "L-192"}) + "</option>");
                        list.append('<option value="1" >' + Language.get({key: "L-193"}) + '</option>');
                        list.append("<option value='2' data-language='L-194'>" + Language.get({key: "L-194"}) + "</option>");
                        list.append("<option value='3' data-language='L-195'>" + Language.get({key: "L-195"}) + "</option>");
                    }

                    //------------------------------------------------------------------

                    for (var i = 4; i <= 30; i++) {
                        list.append("<option value=" + i + " data-language='L-209'>" + i + "  " + Language.get({key: "L-209"}) + "</option>");
                    }

                    //------------------------------------------------------------------

                    list.off("change").on("change", function () {
                        if (
                                Customer.accountInfo.ShowHowManyWeeks < $(this).val() &&
                                Customer.accountInfo.ShowHowManyWeeks > 0
                                ) {
                            Message.showMsg({
                                title: Language.get({
                                    key: "L-23"
                                }),
                                text: Language.get({
                                    key: "L-210"
                                }),
                                icon: Message.type.INFORMATION.icon,
                                time: 2500
                            });
                        } else {
                            //--------------------------------------------------------------

                            _self.getGradedWagers({
                                week: $(this).val(),
                                date: moment(Customer.SERVER_DATE)
                                        .subtract($(this).val(), "week")
                                        .toDate()
                            });

                            //--------------------------------------------------------------

                            msg.html($(this).val() + " " + Language.get({
                                key: "L-211"
                            }));
                        }
                    });

                    //------------------------------------------------------------------

                    $('[data-action="get-graded-wagers"]').off("click").on("click", function () {
                        if (Customer.accountInfo.ShowHowManyWeeks < $(this).data("week") && Customer.accountInfo.ShowHowManyWeeks > 0) {
                            Message.showMsg({
                                title: Language.get({key: "L-23"}),
                                text: Language.get({key: "L-210"}),
                                icon: Message.type.INFORMATION.icon,
                                time: 2500
                            });
                        } else {
                            if ($(this).data("week") > 0) {
                                //----------------------------------------------------------

                                _self.getGradedWagers({
                                    week: $(this).data("week"),
                                    date: moment(Customer.SERVER_DATE)
                                            .subtract($(this).data("week"), "week")
                                            .toDate()
                                });
                            } else {
                                _self.getGradedWagers({
                                    week: $(this).data("week"),
                                    date: Customer.SERVER_DATE
                                });
                            }

                            //--------------------------------------------------------------

                            msg.html($(this).text() + " " + Language.get({
                                key: "L-220"
                            }));
                        }
                    });

                    //-------------------------------------------------------------------

                    list.selectpicker();
                    _self.getGradedWagers({
                        week: 0,
                        date: Customer.SERVER_DATE
                    });

                    //------------------------------------------------------------------

                    options.info.el.tab("show");

                    //------------------------------------------------------------------

                    //tabUI.responsiveTabs(['xs', 'sm']);
                },
                //----------------------------------------------------------------------
                getGradedWagers: function (options) {
                    var _self = this;
                    var _customer = require("customer/customer");
                    var Customer = new _customer();
                    var _wager = require("customer/wager/wager");
                    var Wager = new _wager();
                    var param = {
                        customerID: Customer.ID,
                        week: options.week,
                        token: Security.token,
                        operation: "getGradedWagerByCustomer"
                    };

                    var content = $("#report-graded-wagers .content-table");

                    //------------------------------------------------------------------

                    var table =
                            ' <table class="table table-striped table-bordered table-hover"' +
                            '    cellspacing="0" width="100%" data-table="0">' +
                            '    <thead data-content="head">' +
                            "       <tr>" +
                            '          <th data-language="L-38">' + Language.get({key: "L-38"}) + "</th>" +
                            '          <th data-language="L-221">' + Language.get({key: "L-221"}) + "</th>" +
                            '          <th data-language="L-152">' + Language.get({key: "L-152"}) + "</th>" +
                            '          <th data-language="L-207">' + Language.get({key: "L-207"}) + "</th>" +
                            '          <th data-language="L-70">' + Language.get({key: "L-70"}) + "</th>" +
                            '          <th data-language="L-245">' + Language.get({key: "L-245"}) + "</th>" +
                            '          <th data-language="L-222">' + Language.get({key: "L-222"}) + "</th>" +
                            '          <th data-language="L-223">' + Language.get({key: "L-223"}) + "</th>" +
                            "       </tr>" +
                            "    </thead>" +
                            "    <tfoot>" +
                            "    </tfoot>" +
                            "    <tbody>" +
                            "    </tbody>" +
                            "    </table>";

                    //------------------------------------------------------------------

                    $.ajax({
                        url: this.path + param.operation,
                        cache: false,
                        data: param,
                        type: "POST",
                        beforeSend: function () {
                            UI.setLoad({
                                el: $("[data-page]"),
                                class: "big-load"
                            });
                        },
                        success: function (data) {
                            Log.write({
                                customerID: Customer.ID,
                                description: "View Graded Wagers"
                            });

                            //-----------------------------------------------------------

                            if (data.LIST.length == 0) {
                                content.html(
                                        '<p class="not-rows" data-language="L-224">' + Language.get({key: "L-224"}) + "</p>"
                                        );
                            } else {
                                content.html(table);
                            }

                            //----------------------------------------------------------

                            var wonAmount = 0;
                            var lostAmount = 0;

                            //----------------------------------------------------------

                            for (var i = 0; i < data.LIST.length; i++) {
                                var item = data.LIST[i];
                                var openSpots = "";
                                var param = {
                                    ticketNumber: item.TicketNumber,
                                    wagerNumber: item.WagerNumber,
                                    totalPicks: item.totalPicks,
                                    won: item.AmountWon / 100,
                                    lost: item.AmountLost / 100,
                                    win: item.ToWinAmount / 100,
                                    risk: item.AmountWagered / 100,
                                    description: item.Description.toString()
                                            .split(" ")
                                            .join(Util.concat.PARAM),
                                    spotsAvailable: parseInt(item.WagerCount)
                                };

                                //------------------------------------------------------

                                var detail = {
                                    ticketNumber: item.TicketNumber,
                                    wagerNumber: item.WagerNumber,
                                    flag: item.WagerType
                                };

                                //------------------------------------------------------

                                var description = item.Description.replace(/- /g, "#")
                                        .replace(/Golf/g, "<br><font >Golf</font>")
                                        .replace(/Horses Racing/g, "<br><font >Horses Racing</font>")
                                        .replace(/Martial Arts/g, "<br><font >Martial Arts</font>")
                                        .replace(/Tennis/g, "<br><font >Tennis</font>")
                                        .replace(/Baseball/g, "<br><font >Baseball</font>")
                                        .replace(/Basketball/g, "<br><font >Basketball</font>")
                                        .replace(/Soccer/g, "<br><font >Soccer</font>")
                                        .replace(/Other Sports/g, "<br><font >Other Sports</font>")
                                        .replace(/Football/g, "<br><font >Football</font>")
                                        .replace(/Hockey/g, "<br><font >Hockey</font>");

                                //------------------------------------------------------

                                description = description.substring(4, description.length);

                                //------------------------------------------------------

                                if (item.WagerStatus == Util.status.OPEN) {
                                    openSpots = " <button " + ' data-action="open-spots" ' + " data-param=" + JSON.stringify(param) + ' data-type="' + item.WagerType + '" ' + 'class="btn btn-info btn-sm" >' + "( " + item.WagerCount + " )  " + Language.get({key: "L-68"}) + " " + "</button>";
                                }

                                //------------------------------------------------------

                                wonAmount += parseFloat(param.won);
                                lostAmount += parseFloat(param.lost);

                                //------------------------------------------------------

                                var freeP = '';

                                if (item.FreePlayFlag == "Y") {
                                    freeP = '<span class="label label-primary freeplaySpan fix-t-2">FP</span>';
                                }


                                var element =
                                        "<tr>" +
                                        "<td>" + '<span data-action="show-ticket-detail" ' + " data-param=" + JSON.stringify(detail) + '  class="fa-stack fa-lg">' +
                                        '<i class="fa fa-circle fa-stack-2x"></i>' + ' <i class="fa fa-eye fa-stack-1x fa-inverse"></i>' + "</span>" + "</td>" + "<td>" + $.format.date(item.DailyFigureDate.split(".")[0], "E M/d hh:mm a") + "</td>" +
                                        "<td>" + _self.getTypeInfo({item: item, birdCage: item.ARBirdcageLink, wagerType: item.WagerType, roundRobin: item.RoundRobinLink, ARLink: item.ARLink}) + "</td>" +
                                        '<td data-field="description">' + description + openSpots + freeP + '</td>' +
                                        '<td style="width: 80px;color:#48759E;text-align:center;">' + Util.getCurrency(Customer.accountInfo.CurrencyCode) + parseFloat(param.risk).toFixed(2) + "</td> " +
                                        '<td style="width: 80px;color: #188E75;text-align:center;" >' + Util.getCurrency(Customer.accountInfo.CurrencyCode) + parseFloat(param.win).toFixed(2) + "</td> " +
                                        "<td>" + parseFloat(param.lost).toFixed(2) + "</td> " +
                                        "<td >" + parseFloat(param.won).toFixed(2) + "</td> " +
                                        "</tr>";

                                //------------------------------------------------------

                                content.find("tbody").append(element);
                            }

                            //----------------------------------------------------------

                            var total = wonAmount - lostAmount;
                            var style = Language.get({
                                key: "L-226"
                            });

                            //----------------------------------------------------------

                            if (i > 0) {
                                if (total > 0) {
                                    style = Language.get({
                                        key: "L-71"
                                    });
                                }

                                //------------------------------------------------------

                                content.append("<div class='total'><p>" + Language.get({key: "L-227"}) + "<span class=" + style + ">" + Util.getCurrency(Customer.accountInfo.CurrencyCode) + total + "</span></p></div>");
                            }

                            //----------------------------------------------------------

                            _self.listeners();

                            //----------------------------------------------------------

                            UI.removeElement({
                                el: $('[data-page] [data-control="load"]'),
                                time: 1
                            });
                        }
                    });
                },
                //----------------------------------------------------------------------
                setTransactions: function (options) {


                    var component = options.component.clone();
                    var _self = options.info.self;

                    //------------------------------------------------------------------

                    var _customer = require("customer/customer");
                    var Customer = new _customer();

                    //------------------------------------------------------------------

                    $("#report-transactions").html(component);

                    //------------------------------------------------------------------

                    $("#begin-date").datetimepicker({
                        format: "YYYY-MM-DD"
                    });

                    var list = $('[data-menu="report"] [data-list="weekTransactions"]');


                    //------------------------------------------------------------------

                    //if (Util.isMobile()) {

                    list.append("<option value='0'>Last 2 Weeks</option>");

                    //list.append('<option value="1" >' + Language.get({key: "L-193"}) + '</option>');
                    //}

                    //------------------------------------------------------------------

                    var countWeeks = 12;
                    if (Customer.accountInfo.ShowHowManyWeeks > 0) {
                        countWeeks = Customer.accountInfo.ShowHowManyWeeks;
                    }


                    for (var i = 2; i <= countWeeks; i++) {
                        list.append('<option value="' + i + '" >Last ' + (i + 1) + ' Weeks</option>');
                    }

                    //-------------------------------------------------------------------

                    list.off("change").on("change", function () {

                        var weeks = parseInt($(this).val()) + 1;
                        var beforeDate = moment(Customer.SERVER_DATE);
                        var date = beforeDate.subtract((7 * parseInt(weeks)), "days").format("YYYY-MM-DD");

                        _self.getTransactions({
                            date: date
                        });

                    });

                    //------------------------------------------------------------------

                    $('[data-action="get-transactions"]').on("click", function () {

                        if (Util.isMobile()) {

                            this.innerText = (this.innerText === Language.get({key: "L-430"})) ? Language.get({key: "L-431"}) : Language.get({key: "L-430"});
                            $('[data-type="W"]').toggleClass("hidden");
                            $('[data-type="L"]').toggleClass("hidden");


                        } else {

                            this.innerText = (this.innerText === Language.get({key: "L-428"})) ? Language.get({key: "L-429"}) : Language.get({key: "L-428"});
                            $('[data-type="W"]').toggleClass("hidden");
                            $('[data-type="L"]').toggleClass("hidden");


                        }

                        //--------------------------------------------------------------

                    });

                    //------------------------------------------------------------------

                    _self.getTransactions();

                    //------------------------------------------------------------------

                    options.info.el.tab("show");


                    //------------------------------------------------------------------

                    //tabUI.responsiveTabs(['xs', 'sm']);
                },
                //----------------------------------------------------------------------
                getTransactions: function (options) {

                    var _customer = require("customer/customer");
                    var Customer = new _customer();
                    var content = $("#report-transactions .content-table");
                    var currencyCode = Util.getCurrency(Customer.accountInfo.CurrencyCode);

                    var defaults = {
                        date: moment(Customer.SERVER_DATE).subtract(14, "days").format("YYYY-MM-DD"),
                        trigger: false
                    };

                    var setting = $.extend(defaults, options);
                    var _self = this;
                    var balance = 0;

                    balance = parseFloat(Customer.accountInfo.CurrentBalance * 1 / 100);


                    var param = {
                        customerID: Customer.ID,
                        date: setting.date,
                        token: Security.token,
                        operation: "getTransactions"
                    };


                    //------------------------------------------------------------------

                    var table =
                            ' <table class="table table-bordered"' +
                            '    cellspacing="0" width="100%" data-table="0">' +
                            '    <thead data-content="head">' +
                            "       <tr class ='headerTransaction'>" +
                            '          <th  class= "detailHeaderDate" data-language="L-184">' + Language.get({key: "L-184"}) + "</th>" +
                            '<th class="detailHeaderDescription"   data-language="L-365">' + Language.get({key: "L-365"}) + "</th>" +
                            '          <th  class= "detailHeaderAmount" data-language="L-69">' + Language.get({key: "L-69"}) + "</th>" +
                            '          <th  class= "detailHeaderBalance" data-language="L-229">' + Language.get({key: "L-229"}) + "</th>" +
                            "       </tr>" +
                            "    </thead>" +
                            "    <tfoot>" +
                            "    </tfoot>" +
                            "    <tbody>" +
                            "    </tbody>" +
                            "    </table>";

                    //----------------------------------------------------------

                    content.empty();

                    //----------------------------------------------------------

                    $.ajax({
                        url: this.path + param.operation,
                        cache: false,
                        data: param,
                        type: "POST",
                        beforeSend: function () {
                            UI.setLoad({
                                el: $("[data-page]"),
                                class: "big-load"
                            });
                        },
                        success: function (data) {

                            var el = '';
                            var style = '';
                            var styleBalance = '';

                            if (data.LIST.length > 0) {

                                content.append(table);

                                //----------------------------------------------

                                var listAmount = 0;

                                //----------------------------------------------

                                for (var i = 0; i < data.LIST.length; i++) {
                                    var item = data.LIST[i];

                                    //------------------------------------------

                                    if (item.TranCode == "C") {
                                        listAmount += parseFloat(item.Amount / 100);
                                    } else {
                                        listAmount -= parseFloat(item.Amount / 100);
                                    }
                                }

                                //----------------------------------------------

                                balance -= listAmount;

                                if (balance < 0) {
                                    styleBalance = 'loss';
                                } else {
                                    styleBalance = 'win';
                                }


                                //----------------------------------------------



                                el += '<tr>' +
                                        '<td></td>' +
                                        '<td data-language="L-215">' + Language.get({key: "L-215"}) + '</td>' +
                                        '<td class="' + style + '"></td>' +
                                        '<td class="' + styleBalance + '" style="text-align:right;">' + currencyCode + Util.formatCurrency({val: balance}) + '</td>' +
                                        '</tr>';



                                //----------------------------------------------

                                for (var i = 0; i < data.LIST.length; i++) {

                                    var item = data.LIST[i];
                                    var amount = item.Amount / 100;
                                    var simbol = '';

                                    switch (item.TranType) {
                                        case Util.status.WIN:
                                        case Util.status.DEPOSIT:
                                        case Util.status.PAY:
                                        case Util.trans.TRANSFER_CREDIT.type:
                                            style = "win";
                                            balance += parseFloat(item.Amount / 100);
                                            break;

                                            //----------------------------------------------

                                        case Util.status.LOSS:
                                        case Util.status.PLACED:
                                        case Util.status.CIRCLE:
                                        case Util.trans.DEBIT_ADJUSTMENT.type:
                                        case Util.trans.AGENT_DISTRIBUTION.type:
                                            style = "loss";
                                            balance -= parseFloat(item.Amount / 100);
                                            simbol = '-';
                                            break;

                                        case Util.trans.ZERO_BALANCE_DEBIT.type :

                                            switch (item.TranCode) {
                                                case Util.trans.DEBIT  :
                                                    style = "loss";
                                                    balance -= parseFloat(item.Amount / 100);
                                                    simbol = '-';
                                                    break;

                                                case Util.trans.CREDIT  :
                                                    style = "win";
                                                    balance += parseFloat(item.Amount / 100);
                                                    break;
                                            }


                                            break;

                                        case 'X' :

                                            switch (item.TranCode) {
                                                case Util.trans.DEBIT  :
                                                    style = "loss";
                                                    balance -= parseFloat(item.Amount / 100);
                                                    simbol = '-';
                                                    break;

                                                case Util.trans.CREDIT  :
                                                    style = "win";
                                                    balance += parseFloat(item.Amount / 100);
                                                    break;
                                            }


                                            break;
                                    }

                                    //------------------------------------------

                                    if (balance < 0) {
                                        styleBalance = 'loss';
                                    } else {
                                        styleBalance = 'win';
                                    }

                                    //------------------------------------------

                                    var action = '';

                                    if (item.ShortDesc.toString().search(_self.buyOutKey) === 0) {

                                        var ticketDeleted = item.ShortDesc.toString().split('ticket')[1].toString().trim();

                                        action = 'data-action="get-delete-wager" ticket-trans="' + ticketDeleted + '"';

                                    }

                                    el += '<tr ' + action + '>' +
                                            '<td>' + moment(item.TranDateTime).format('LLL') + '</td>' +
                                            '<td>' + item.ShortDesc + '</td>' +
                                            '<td class="' + style + '">' + simbol + currencyCode + Util.formatCurrency({val: amount}) + '</td>' +
                                            '<td class="' + styleBalance + '">' + currencyCode + Util.formatCurrency({val: balance}) + '</td>' +
                                            '</tr>';
                                }

                                //----------------------------------------------

                                content.find('tbody').html(el);

                            }

                            //----------------------------------------------------------

                            content.find('[data-action="show-wager-detail"]').on("click", function () {
                                _self.getWagerDetailTransaction({
                                    gradeNum: $(this).data("param").gradeNum
                                });
                            });


                            content.find('[data-action="get-delete-wager"]').on("click", function () {

                                UI.getComponent({
                                    component: "modal",
                                    func: _self.setDeleteWager,
                                    info: {
                                        ticketNumber: $(this).attr('ticket-trans'),
                                        self: _self
                                    }
                                });

                            });


                            //----------------------------------------------------------

                            UI.removeElement({
                                el: $('[data-page] [data-control="load"]'),
                                time: 1
                            });
                        }
                    });
                },
                //--------------------------------------------------------------

                setDeleteWager: function (options) {
                    var modal = options.component;
                    var info = options.info;
                    var _customer = require("customer/customer");
                    var Customer = new _customer();
                    var _self = info.self;

                    //----------------------------


                    $('[data-modal="ticket-detail"]').remove();

                    modal.find('.modal').addClass('modal-ticket-delete');
                    modal.find("[data-modal]").attr("data-modal", "ticket-detail");
                    modal.find('[data-field="title"]').html("Ticket Detail (" + "<span>" + info.ticketNumber + "</span> )");
                    modal.find('.modal-body').append('<div class="tab-content responsive" id="reportsTypes"> ' +
                            ' <div class="tab-pane active" id="all-pending" data-type="all">' +
                            '<table class="table table-striped table-bordered table-hover" cellspacing="0" width="100%" data-table="0"> ' +
                            '<tbody></tbody></table><div data-list="wagers"> </div>' +
                            ' </div>');

                    $('[data-content="general"]').append(modal.html());

                    UI.removeElement({el: $('body [data-control="load"]'), time: 1});

                    _self.getPendingWagers({

                        deleteWagers: true,
                        ticketNumber: info.ticketNumber

                    });




                },

                //----------------------------------------------------------------------
                getWagerDetailTransaction: function (options) {
                    var _self = this;
                    var _customer = require("customer/customer");
                    var Customer = new _customer();
                    var content = $("#report-transactions .content-table");

                    //------------------------------------------------------------------

                    var param = {
                        customerID: Customer.ID,
                        gradeNum: options.gradeNum,
                        token: Security.token,
                        operation: "getWagerDetailTransaction"
                    };

                    //------------------------------------------------------------------

                    content.find(".table").remove();

                    //------------------------------------------------------------------

                    var table =
                            '<table class="table table-striped table-bordered table-hover"' +
                            '                      cellspacing="0" width="100%" data-table="0">' +
                            '                    <thead data-content="head">' +
                            "                        <tr>" +
                            '                            <th data-language="L-38">' + Language.get({key: "L-38"}) + "</th>" +
                            '                            <th data-language="L-206">' + Language.get({key: "L-206"}) + "</th>" +
                            '                            <th data-language="L-152">' + Language.get({key: "L-152"}) + "</th>" +
                            '                            <th data-language="L-207">' + Language.get({key: "L-207"}) + "</th>" +
                            '                            <th data-language="L-226">' + Language.get({key: "L-226"}) + "</th>" +
                            '                           <th data-language="L-223">' + Language.get({key: "L-223"}) + "</th>" +
                            "                        </tr>" +
                            "                    </thead>" +
                            "                    <tfoot>" +
                            "                    <tbody>" +
                            "        </tbody>" +
                            "    </table>";
                    //----------------------------------------------------------

                    content.html(table);

                    //------------------------------------------------------------------

                    $.ajax({
                        url: this.path + param.operation,
                        cache: false,
                        data: param,
                        type: "POST",
                        beforeSend: function () {
                            UI.setLoad({
                                el: $("[data-page]"),
                                class: "big-load"
                            });
                        },
                        success: function (data) {
                            for (var i = 0; i < data.LIST.length; i++) {
                                var item = data.LIST[i];
                                var openSpots = "";
                                var param = {
                                    ticketNumber: item.TicketNumber,
                                    wagerNumber: item.WagerNumber,
                                    totalPicks: item.totalPicks,
                                    win: item.ToWinAmount / 100,
                                    risk: item.AmountWagered / 100,
                                    description: item.Description.toString()
                                            .split(" ")
                                            .join(Util.concat.PARAM),
                                    spotsAvailable: parseInt(item.WagerCount)
                                };

                                //------------------------------------------------------

                                var detail = {
                                    ticketNumber: item.TicketNumber,
                                    wagerNumber: item.WagerNumber,
                                    flag: item.WagerType
                                };

                                //------------------------------------------------------

                                var description = item.Description.replace(/- /g, "#")
                                        .replace(/Golf/g, "<br><font >Golf</font>")
                                        .replace(/Horses Racing/g, "<br><font >Horses Racing</font>")
                                        .replace(/Martial Arts/g, "<br><font >Martial Arts</font>")
                                        .replace(/Tennis/g, "<br><font >Tennis</font>")
                                        .replace(/Baseball/g, "<br><font >Baseball</font>")
                                        .replace(/Basketball/g, "<br><font >Basketball</font>")
                                        .replace(/Soccer/g, "<br><font >Soccer</font>")
                                        .replace(/Other Sports/g, "<br><font >Other Sports</font>")
                                        .replace(/Football/g, "<br><font >Football</font>")
                                        .replace(/Hockey/g, "<br><font >Hockey</font>");

                                //------------------------------------------------------

                                description = description.substring(4, description.length);

                                //------------------------------------------------------

                                if (item.WagerStatus == Util.status.OPEN) {
                                    openSpots = " <button " + ' data-action="open-spots" ' + " data-param=" + JSON.stringify(param) + 'data-type="' + item.WagerType + '" ' + 'class="btn btn-info btn-sm" >' + "( " + item.WagerCount + " ) " + Language.get({key: "L-68"}) + "</button>";
                                }

                                //------------------------------------------------------

                                var freeP = '';

                                if (item.FreePlayFlag == "Y") {
                                    freeP = '<span class="label label-primary freeplaySpan fix-t-3">FP</span>';
                                }


                                var element =
                                        "<tr>" +
                                        "<td>" + '<span data-action="show-ticket-detail" ' + "data-param=" + JSON.stringify(detail) + 'class="fa-stack fa-lg">' + '<i class="fa fa-circle fa-stack-2x"></i>' + ' <i class="fa fa-eye fa-stack-1x fa-inverse"></i>' + "</span>" + "</td>" +
                                        "<td>" + $.format.date(item.AcceptedDateTime.split(".")[0], "E M/d hh:mm a") + "</td>" +
                                        "<td>" + _self.getTypeInfo({item: item, birdCage: item.ARBirdcageLink, wagerType: item.WagerType, roundRobin: item.RoundRobinLink, ARLink: item.ARLink}) + "</td>" +
                                        '<td data-field="description">' + description + openSpots + freeP + '</td>' +
                                        '<td style="width: 80px;text-align:center;">' + Util.getCurrency(Customer.accountInfo.CurrencyCode) + parseFloat(item.AmountLost) / 100 + "</td> " +
                                        '<td style="width: 80px;color: red;text-align:center;">' + Util.getCurrency(Customer.accountInfo.CurrencyCode) + parseFloat(item.AmountWon) / 100 + "</td> " +
                                        "</tr>";

                                //------------------------------------------------------

                                content.find("tbody").append(element);
                            }

                            //----------------------------------------------------------

                            _self.listeners();

                            //----------------------------------------------------------

                            UI.removeElement({
                                el: $('[data-page] [data-control="load"]'),
                                time: 1
                            });
                        }
                    });
                },
                //----------------------------------------------------------------------
                getWagersByFigureDateMobile: function (options) {

                    options.el.off('click');

                    var _self = this;
                    var _customer = require("customer/customer");
                    var Customer = new _customer();
                    var _wager = require("customer/wager/wager");
                    var Wager = new _wager();
                    var content = $('[data-panel="wagers-daily-figure"]');
                    var singleWagerType = "SMLEA";
                    var element = "";
                    var gradedType = options.graded == true ? 1 : 0;
                    var type = '';

                    if (options.graded === undefined) {
                        gradedType = 3;
                    }

                    //------------------------------------------------------------------
                    var param = {
                        customerID: Customer.ID,
                        figureDate: options.figureDate,
                        graded: gradedType,
                        week: $('.select-li [data-list="week"]').val(),
                        token: Security.token,
                        operation: "getWagersByFigureDate",
                        RRO: Util.RRO
                    };

                    var divContent =
                            "<div  class='accordion-inner table-responsive' >" +
                            "<div id='daily-div' class='col-md-12 col-sm-12 col-xs-12 dvWagerRow'>" +
                            "<div class='col-md-12 col-sm-12 col-xs-12 dvHeader'><label>" + ((options.graded) ? Language.get({key: "L-437"}) : Util.dayName[new Date(options.figureDate).getDay()]) + "</label></div>" +
                            "</div>" +
                            "</div>";


                    content.empty();
                    content.append(divContent);

                    if (gradedType === 3) {
                        content.find('.dvHeader').remove();
                    }


                    $.ajax({
                        url: this.path + param.operation,
                        cache: false,
                        data: param,
                        type: "POST",
                        beforeSend: function () {
                            UI.setLoad({
                                el: $("[data-page]"),
                                class: "big-load"
                            });
                        },
                        success: function (data) {

                            var ticketWagerNumberTmp = '';
                            var elementTract = '';


                            if (gradedType === 3) {

                                var table =
                                        ' <div  class="accordion-inner table-responsive" > ' +
                                        '               <table id="daily-table"  class="table table-striped table-bordered table-hover"' +
                                        '                      cellspacing="0" width="100%" data-table="0">' +
                                        '                    <thead data-content="head">' +
                                        "                        <tr>" +
                                        '                            <th data-language="L-206">' + Language.get({key: "L-206"}) + "</th>" +
                                        '                            <th data-language="L-207">' + Language.get({key: "L-207"}) + "</th>" +
                                        '                            <th data-language="L-421">' + Language.get({key: "L-421"}) + "</th>" +
                                        "                        </tr>" +
                                        "                    </thead>" +
                                        "                    <tfoot>" +
                                        "                    <tbody>";

                                element = table;


                                for (var i = 0; i < data.LIST.INFO.length; i++) {
                                    var item = data.LIST.INFO[i];
                                    var description = "";
                                    var amountGeneral = parseFloat(item.Amount) / 100;
                                    var simbolTrac = '';

                                    if (item.TranCode === Util.trans.DEBIT) {

                                        type = 'Debit';
                                        lossTotal += amountGeneral;
                                        simbolTrac = '-';

                                    } else {

                                        type = 'Credit';
                                        wonTotal += amountGeneral;

                                    }




                                    element += '<tr class= "header">' +
                                            '<td class="acceptedColumn leftAlign">' + $.format.date(item.DailyFigureDate, "E M/d hh:mm a") + "</td>" +
                                            '<td class="leftAlign" data-field="description">' + item.ShortDesc + "</td> " +
                                            "<td style='text-align: right;'>" +
                                            _self.drawWinLoss({val: simbolTrac + parseFloat(item.Amount / 100)}) +
                                            "</td>" +
                                            "</tr>";

                                    //------------------------------------------------------




                                }


                                element += "        </tbody>" +
                                        "    </table>" +
                                        "</div>";



                            } else {


                                for (var i = 0; i < data.LIST.INFO.length; i++) {
                                    var item = data.LIST.INFO[i];
                                    var description = "";
                                    var wagerFormat = "<div data-ticket='{@dataTicket}' class='col-md-12 col-sm-12 col-xs-12 dvWagerContent'>{wagerContent}</div>";


                                    var gameTicketWagerNumber = item.TicketNumber + "-" + item.WagerNumber;
                                    //Valida que el juego no haya sido procesado anteriormente
                                    if (gameTicketWagerNumber != ticketWagerNumberTmp) {
                                        ticketWagerNumberTmp = gameTicketWagerNumber;
                                        var ticketDetail = "";
                                        var headerWagerFormat = "<div data-group='{@dataGroup}' class='col-md-12 col-sm-12 col-xs-12 dvWagerTicketDeatil hidden'>" +
                                                "<div class='col-md-4 col-sm-4 col-xs-4'><label class='{headerClass}'>{header}</label></div>" +
                                                "<div class='col-md-8 col-sm-8 col-xs-8 BOLA-3'><label class='{contentClass}'>{content}</label></div>" +
                                                "</div>";
                                        var riskWinAmount = Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.AmountWagered / 100}) + " / " + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.ToWinAmount / 100});
                                        var scheduled = $.format.date(item.GameDateTime.split(".")[0], "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT;
                                        var accepted = $.format.date(item.AcceptedDateTime.split(".")[0], "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT;
                                        var wagerType = (item.WagerType === "C" ? "" : _self.getTypeInfo({item: item, birdCage: item.ARBirdcageLink, wagerType: item.WagerType, roundRobin: item.RoundRobinLink, ARLink: item.ARLink, totalPicks: item.TotalPicks}));

                                        //-------- Carga la informacion de los juegos --------    
                                        var wagerData = data.LIST.INFO.filter(function (el) {
                                            return el.TicketNumber == item.TicketNumber && el.WagerNumber == item.WagerNumber;
                                        });


                                        if (singleWagerType.includes(item.WagerType)) {
                                            // Para las apuestas simples
                                            var rotationNumber = _self.getRotationNumber({Team1ID: item.Team1ID, ChosenTeamID: item.ChosenTeamID, Team1RotNum: item.Team1RotNum, Team2RotNum: item.Team2RotNum});
                                            var statusDesc = _self.getWagerStatus({WagerStatus: item.WagerStatus});
                                            var selection = "";
                                            var gameTeams = "";

                                            var pitchers = '';

                                            if (item.ListedPitcher1 != null &&
                                                    item.SportType.toString().trim().toUpperCase() === Util.SPORT.BASEBALL) {
                                                var stateR = _self.statePitcher({
                                                    flag: item.Pitcher1ReqFlag
                                                });
                                                var stateL = _self.statePitcher({
                                                    flag: item.Pitcher2ReqFlag
                                                });

                                                //--------------------------------------------------------------

                                                pitchers =
                                                        '<div class="pitcher-pending">' + item.ListedPitcher1 + " - " + stateR + " | " + item.ListedPitcher2 + " - " + stateL + "</div>";
                                            }

                                            // Si el rotation number es diferente de 0 tiene informacion que mostrar
                                            if (item.Team1RotNum != 0) {
                                                statusDesc += " (" + item.Team1ID + " " + item.Team1FinalScore + "-" + item.Team2ID + " " + item.Team2FinalScore + ")";
                                                selection = item.SportSubType + " - " + ((item.LegWagerType === "L") ? item.Team1RotNum + " / " + item.Team2RotNum : rotationNumber) + "   " + item.PeriodDescription.trim() + " " + wagerType + pitchers;
                                                gameTeams = item.Team1ID + "/" + item.Team2ID;
                                            }

                                            ticketDetail = _self.getResultMobileTicket(wagerData);

                                            var commentH = '';

                                            if (item.Comments !== null && item.Comments !== '') {
                                                commentH = headerWagerFormat.replace("{headerClass}", "normalDescription")
                                                        .replace("{header}", "Game Note: ")
                                                        .replace("{contentClass}", "normalDescription")
                                                        .replace("{content}", item.Comments)
                                                        .replace("{@dataGroup}", gameTicketWagerNumber);
                                            }


                                            ticketDetail += headerWagerFormat.replace("{headerClass}", "normalDescription").replace("{header}", (Language.get({key: "L-38"}) + "#:")).replace("{contentClass}", "").replace("{content}", item.TicketNumber).replace("{@dataGroup}", gameTicketWagerNumber) +
                                                    headerWagerFormat.replace("{headerClass}", "normalDescription").replace("{header}", (Language.get({key: "L-423"}) + ":")).replace("{contentClass}", "normalDescription").replace("{content}", statusDesc).replace("{@dataGroup}", gameTicketWagerNumber) +
                                                    headerWagerFormat.replace("{headerClass}", "normalDescription").replace("{header}", (Language.get({key: "L-244"}) + "/" + Language.get({key: "L-71"}) + ":")).replace("{contentClass}", "").replace("{content}", riskWinAmount).replace("{@dataGroup}", gameTicketWagerNumber) +
                                                    headerWagerFormat.replace("{headerClass}", "normalDescription").replace("{header}", (Language.get({key: "L-237"}) + ":")).replace("{contentClass}", "normalDescription").replace("{content}", gameTeams).replace("{@dataGroup}", gameTicketWagerNumber) +
                                                    headerWagerFormat.replace("{headerClass}", "normalDescription").replace("{header}", (Language.get({key: "L-424"}) + ":")).replace("{contentClass}", "normalDescription").replace("{content}", selection).replace("{@dataGroup}", gameTicketWagerNumber) +
                                                    headerWagerFormat.replace("{headerClass}", "normalDescription").replace("{header}", (Language.get({key: "L-426"}) + ":")).replace("{contentClass}", "normalDescription").replace("{content}", scheduled).replace("{@dataGroup}", gameTicketWagerNumber) +
                                                    headerWagerFormat.replace("{headerClass}", "normalDescription").replace("{header}", (Language.get({key: "L-206"}) + ":")).replace("{contentClass}", "normalDescription").replace("{content}", accepted).replace("{@dataGroup}", gameTicketWagerNumber) +
                                                    headerWagerFormat.replace("{headerClass}", "normalDescription").replace("{header}", (Language.get({key: "L-425"}) + ":")).replace("{contentClass}", "normalDescription").replace("{content}", item.TicketWriter.replace('BLR', 'RB')).replace("{@dataGroup}", gameTicketWagerNumber) + commentH;
                                        } else {
                                            var statusDesc = _self.getWagerStatus({WagerStatus: item.Outcome});
                                            if (item.WagerType === "C" || item.WagerType === "G") {


                                                if (item.WagerType === 'G') {


                                                    if (item.WagerStatus === 'W') {
                                                        statusDesc = 'Won';

                                                    }


                                                    if (item.WagerStatus === 'L') {
                                                        statusDesc = 'Loss';
                                                    }


                                                } else {

                                                    statusDesc = _self.getWagerStatus({WagerStatus: item.WagerStatus});

                                                }


                                                // Si es un contest
                                                ticketDetail = _self.getResultMobileTicket(wagerData);

                                                ticketDetail += headerWagerFormat.replace("{headerClass}", "normalDescription").replace("{header}", (Language.get({key: "L-38"}) + "#:")).replace("{contentClass}", "").replace("{content}", item.TicketNumber).replace("{@dataGroup}", gameTicketWagerNumber) +
                                                        headerWagerFormat.replace("{headerClass}", "normalDescription").replace("{header}", (Language.get({key: "L-423"}) + ":")).replace("{contentClass}", "normalDescription").replace("{content}", statusDesc).replace("{@dataGroup}", gameTicketWagerNumber) +
                                                        headerWagerFormat.replace("{headerClass}", "normalDescription").replace("{header}", (Language.get({key: "L-244"}) + "/" + Language.get({key: "L-71"}) + ":")).replace("{contentClass}", "").replace("{content}", riskWinAmount).replace("{@dataGroup}", gameTicketWagerNumber) +
                                                        headerWagerFormat.replace("{headerClass}", "normalDescription").replace("{header}", (Language.get({key: "L-237"}) + ":")).replace("{contentClass}", "normalDescription").replace("{content}", item.Team2ID).replace("{@dataGroup}", gameTicketWagerNumber) +
                                                        headerWagerFormat.replace("{headerClass}", "normalDescription").replace("{header}", (Language.get({key: "L-424"}) + ":")).replace("{contentClass}", "normalDescription").replace("{content}", scheduled).replace("{@dataGroup}", gameTicketWagerNumber) +
                                                        headerWagerFormat.replace("{headerClass}", "normalDescription").replace("{header}", (Language.get({key: "L-206"}) + ":")).replace("{contentClass}", "normalDescription").replace("{content}", accepted).replace("{@dataGroup}", gameTicketWagerNumber) +
                                                        headerWagerFormat.replace("{headerClass}", "normalDescription").replace("{header}", (Language.get({key: "L-425"}) + ":")).replace("{contentClass}", "normalDescription").replace("{content}", item.TicketWriter.replace('BLR', 'RB')).replace("{@dataGroup}", gameTicketWagerNumber);
                                            } else {
                                                // Si es multi-wager
                                                var ticketHeaderFormat = "<div class='col-md-12 col-sm-12 col-xs-12 dvWagerTicketHeader'>" +
                                                        "<div class='col-md-6 col-sm-6 col-xs-6 dvWagerType '><label class='normalDescription'>{header}</label></div>" +
                                                        "<div class='col-md-6 col-sm-6 col-xs-6 dvWagerAmount'><span class='label {amountClass} normal-weight'>{amount}</span></div>" +
                                                        "</div>";


                                                var wonTotal = parseFloat(item.AmountWon) / 100;
                                                var lossTotal = parseFloat(item.AmountLost) / 100;

                                                var amountClass = Util.setBackground(wonTotal - lossTotal);


                                                var amountC = _self.getMathSing({Amount: (wonTotal - lossTotal)}) + Util.getCurrency(Customer.accountInfo.CurrencyCode) + " " + Math.abs((wonTotal - lossTotal)).toFixed(2);

                                                var header = ticketHeaderFormat.replace("{header}", wagerType)
                                                        .replace("{amountClass}", amountClass)
                                                        .replace("{amount}", amountC);

                                                var commentH = '';

//                                                if (item.Comments !== null && item.Comments !== '') {
//                                                    commentH = headerWagerFormat.replace("{headerClass}", "normalDescription")
//                                                            .replace("{header}", "Game Note: ")
//                                                            .replace("{contentClass}", "normalDescription")
//                                                            .replace("{content}", item.Comments)
//                                                            .replace("{@dataGroup}", gameTicketWagerNumber);
//                                                }


                                                var ticketDescription = headerWagerFormat.replace("{headerClass}", "normalDescription")
                                                        .replace("{header}", "Ticket#: ")
                                                        .replace("{contentClass}", "")
                                                        .replace("{content}", item.TicketNumber)
                                                        .replace("{@dataGroup}", gameTicketWagerNumber) +
                                                        headerWagerFormat.replace("{headerClass}", "normalDescription")
                                                        .replace("{header}", "Status: ")
                                                        .replace("{contentClass}", "normalDescription")
                                                        .replace("{content}", statusDesc)
                                                        .replace("{@dataGroup}", gameTicketWagerNumber) +
                                                        headerWagerFormat.replace("{headerClass}", "normalDescription")
                                                        .replace("{header}", "Risk/Win: ")
                                                        .replace("{contentClass}", "")
                                                        .replace("{content}", riskWinAmount)
                                                        .replace("{@dataGroup}", gameTicketWagerNumber) + commentH +
                                                        headerWagerFormat.replace("{headerClass}", "normalDescription")
                                                        .replace("{header}", (Language.get({key: "L-206"}) + ":"))
                                                        .replace("{contentClass}", "normalDescription")
                                                        .replace("{content}", accepted).replace("{@dataGroup}", gameTicketWagerNumber) +
                                                        headerWagerFormat.replace("{headerClass}", "normalDescription")
                                                        .replace("{header}", "Placed On: ")
                                                        .replace("{contentClass}", "normalDescription")
                                                        .replace("{content}", item.TicketWriter.replace('BLR', 'RB'))
                                                        .replace("{@dataGroup}", gameTicketWagerNumber);

                                                ticketDetail += header + ticketDescription + _self.getResultMobileTicket(wagerData);


                                            }
                                        }
                                        element += wagerFormat.replace("{wagerContent}", ticketDetail).replace("{@dataTicket}", gameTicketWagerNumber);
                                    }

                                }
                            }


                            var el = '';

                            if (data.LIST.LIVE_CASINO_POSTED.length > 0) {

                                for (var i = 0; i < data.LIST.LIVE_CASINO_POSTED.length; i++) {

                                    var info = data.LIST.LIVE_CASINO_POSTED[i];

                                    var amount = info.Amount;

                                    var style = 'danger';
                                    var simbol = '-';


                                    if (amount > 0) {
                                        style = 'success ';
                                        simbol = '';
                                    }

                                    if (info.TranCode === 'D') {
                                        style = 'danger';
                                        simbol = '-';
                                    }

                                    if (info.TranCode === 'C') {
                                        style = 'success';
                                        simbol = '+';
                                    }


                                    var action = '';

                                    if (info.ShortDesc.toString().search(_self.buyOutKey) === 0) {

                                        var ticketDeleted = info.ShortDesc.toString().split('ticket')[1].toString().trim();

                                        action = 'data-action="get-delete-wager" ticket-trans="' + ticketDeleted + '"';

                                    }

                                    el += '<div ' + action + ' class="col-md-12 col-sm-12 col-xs-12 dvWagerHeaderP" style=" padding-left: 0px; height: 38px; padding-top: 9px;     padding-right: 9px;">' +
                                            '<div class="col-md-8 col-sm-8 col-xs-8 BOLA-4" style="    padding-left: 9px;"><label>' + info.ShortDesc + '</label> ' +
                                            '<label class="period"></label></div>' +
                                            '<div class="col-md-4 col-sm-4 col-xs-4" style=" text-align: right; padding-right: 0px; ">' +
                                            '<span style=" font-size: 14px; " class="label label-' + style + '">' + simbol + Util.currency[Customer.accountInfo.CurrencyCode] + Util.formatCurrency({val: (amount / 100)})
                                            + '</span></div>' +
                                            '</div>';

                                }




                            }


                            var el2 = '';

                            if (data.LIST.CASINO_POSTED.length > 0) {

                                el2 = '<div style="    width: 100%; float: left;    height: 22px;"><p class="casino-title">Casino Game Details</p></div>';

                                for (var i = 0; i < data.LIST.CASINO_POSTED.length; i++) {

                                    var info = data.LIST.CASINO_POSTED[i];
                                    var amount = 0;

                                    var style = 'danger';
                                    var simbol = '-';

                                    var amount = 0;

                                    if (parseFloat(info.WinAmount) > parseFloat(info.RiskAmount)) {
                                        amount = parseInt(info.WinAmount) - parseFloat(info.RiskAmount);
                                        style = 'success ';
                                        simbol = '+';

                                    } else {

                                        amount = parseInt(info.RiskAmount) - parseFloat(info.WinAmount);
                                    }



//                                    if (parseInt(info.WinAmount) === 0) {
//
//                                        amount = info.RiskAmount;
//                                    } else
//
//                                    {
//
//                                        style = 'success ';
//                                        simbol = '+';
//                                        amount = info.WinAmount;
//
//
//                                    }


                                    el2 += '<div class="col-md-12 col-sm-12 col-xs-12 dvWagerHeaderP" style=" padding-left: 0px; height: 38px; padding-top: 9px;    padding-right: 9px; ">' +
                                            '<div class="col-md-8 col-sm-8 col-xs-8 BOLA-9" style="    padding-left: 9px;"><label>' + info.PlayDescription + '</label> ' +
                                            '<label class="period"></label></div>' +
                                            '<div class="col-md-4 col-sm-4 col-xs-4" style=" text-align: right; padding-right: 0px; ">' +
                                            '<span style=" font-size: 14px; " class="label label-' + style + '">' + simbol + Util.currency[Customer.accountInfo.CurrencyCode] + Util.formatCurrency({val: (amount / 100)})
                                            + '</span></div></div>';

                                }




                            }



                            content.find("#daily-div").append(element + el + el2);
                            _self.listeners();


                            options.el.on("click", function () {



                                var $th = $(this).closest('table').find('th').eq($(this).data('index') - 1);

                                if (Util.isMobile()) {
                                    _self.getWagersByFigureDateMobile({figureDate: moment($th.data('date')).format('YYYY-MM-DD'), graded: $th.data('graded'), el: $(this)});
                                } else {
                                    _self.getWagersByFigureDate({figureDate: moment($th.data('date')).format('YYYY-MM-DD'), graded: $th.data('graded')});
                                    $(".popover.pop-min").popover('destroy');
                                    //------------------------------------------------------

                                    Message.showNotify({
                                        msg: Language.get({key: 'L-219'}),
                                        position: 'bottom',
                                        el: $(this),
                                        trigger: 'click',
                                        class: 'pop-min'
                                    });
                                }

                                //------------------------------------------------------


                            });


                            // options.el.prop('disabled', false);

                            $('[data-ticket]').each(function () {
                                var ticket = $(this).attr('data-ticket');
                                $('[data-ticket="' + ticket + '"]').not(':first').remove();
                            });

                            content.find('[data-action="get-delete-wager"]').on("click", function () {

                                UI.getComponent({
                                    component: "modal",
                                    func: _self.setDeleteWager,
                                    info: {
                                        ticketNumber: $(this).attr('ticket-trans'),
                                        self: _self
                                    }
                                });

                            });



                            $('.report-h-repeat:not(.c-type)').first().remove();


                        }
                    });


                    //----------------------------------------------------------
                    UI.removeElement({
                        el: $('[data-page] [data-control="load"]'),
                        time: 1
                    });
                },
                //----------------------------------------------------------------------
                getWagersByFigureDate: function (options) {
                    var _self = this;
                    var _customer = require("customer/customer");
                    var Customer = new _customer();
                    var _wager = require("customer/wager/wager");
                    var Wager = new _wager();
                    var content = $('[data-panel="wagers-daily-figure"]');
                    var element = "";

                    var gradedType = options.graded == true ? 1 : 0;

                    if (options.graded === undefined) {
                        gradedType = 3;
                    }




                    var param = {
                        customerID: Customer.ID,
                        figureDate: options.figureDate,
                        token: Security.token,
                        graded: gradedType,
                        week: $('[data-list="week"]').val(),
                        operation: "getWagersByFigureDate",
                        RRO: Util.RRO
                    };

                    //------------------------------------------------------------------
                    var table =
                            ' <div  class="accordion-inner table-responsive" > ' +
                            '               <table id="daily-table"  class="table table-striped table-bordered table-hover"' +
                            '                      cellspacing="0" width="100%" data-table="0">' +
                            '                    <thead data-content="head">' +
                            "                        <tr>" +
                            '                            <th data-language="L-206">' + Language.get({key: "L-206"}) + "</th>" +
                            '                            <th data-language="L-152">' + Language.get({key: "L-152"}) + "</th>" +
                            '                            <th data-language="L-207">' + Language.get({key: "L-207"}) + "</th>" +
                            '                            <th data-language="L-421">' + Language.get({key: "L-421"}) + "</th>" +
                            "                        </tr>" +
                            "                    </thead>" +
                            "                    <tfoot>" +
                            "                    <tbody>" +
                            "        </tbody>" +
                            "    </table>" +
                            "</div>";

                    //------------------------------------------------------------------
                    var tableCasino =
                            ' <div class="accordion-inner table-responsive" > ' +
                            '               <table id="casino-table" class="table table-striped table-bordered table-hover"' +
                            '                      cellspacing="0" width="100%" data-table="0">' +
                            '                    <thead data-content="head">' +
                            "                        <tr>" +
                            '                            <th style="text-align:left" data-language="L-438">' + Language.get({key: "L-438"}) + "</th>" +
                            '                            <th data-language="L-69"  style="text-align:right" >' + Language.get({key: "L-69"}) + "</th>" +
                            "                        </tr>" +
                            "                    </thead>" +
                            "                    <tfoot>" +
                            "                    <tbody>" +
                            "        </tbody>" +
                            "    </table>" +
                            "</div>";

                    //------------------------------------------------------------------
                    var tableLiveCasino =
                            ' <div class="accordion-inner table-responsive" > ' +
                            '               <table id="live-casino-table" class="table table-striped table-bordered table-hover"' +
                            '                      cellspacing="0" width="100%" data-table="0">' +
                            '                    <thead data-content="head">' +
                            "                        <tr>" +
                            "                            <th data-language='L-207' class='transactionColumn'>" + Language.get({key: "L-365"}) + "</th>" +
                            '                            <th data-language="L-207">' + Language.get({key: "L-207"}) + "</th>" +
                            '                            <th data-language="L-69" style="text-align:right">' + Language.get({key: "L-69"}) + "</th>" +
                            //                    '                            <th data-language="L-184">' + Language.get({ key: "L-184" }) + "</th>" +
                            "                        </tr>" +
                            "                    </thead>" +
                            "                    <tfoot>" +
                            "                    <tbody>" +
                            "        </tbody>" +
                            "    </table>" +
                            "</div>";

                    //------------------------------------------------------------------

                    content.empty();

                    content.append(table);
                    content.append(tableCasino);
                    content.append(tableLiveCasino);

                    //------------------------------------------------------------------
                    var iterationNumber = (options.graded) ? 8 : 1;

                    var wonTotal = 0;
                    var lossTotal = 0;

                    var listTicket = [];

                    // for (var index = 0; index < iterationNumber; index++) {    


                    $.ajax({
                        url: this.path + param.operation,
                        cache: false,
                        data: param,
                        type: "POST",
                        beforeSend: function () {
                            UI.setLoad({
                                el: $("[data-page]"),
                                class: "big-load"
                            });
                        },
                        success: function (data) {
                            if ((!data.LIST.INFO || data.LIST.INFO.length <= 0) && !options.graded) {
                                element =
                                        "<tr>" +
                                        "<td>0</td>" +
                                        "<td>0</td>" +
                                        "<td>0</td>" +
                                        "<td >0</td> " +
                                        "</tr>";

                                //  content.find("table#daily-table tbody").append(element);
                            }

                            //----------------------------------------------------------

                            if (!data.LIST.CASINO_POSTED || data.LIST.CASINO_POSTED.length <= 0) {
                                content.find("table#casino-table").remove();
                            }

                            //----------------------------------------------------------

                            //if (!data.LIST.LIVE_CASINO_POSTED || data.LIST.LIVE_CASINO_POSTED.length <= 0) {
                            content.find("table#live-casino-table").remove();
                            // }
                            //----------------------------------------------------------


                            //--------------- Setea el valor de "ticketWagerNumberTmp" para que la iteracion no repita la informaciÃ³n -------------------------
                            var ticketWagerNumberTmp = '';


                            if (gradedType === 3) {

                                for (var i = 0; i < data.LIST.INFO.length; i++) {
                                    var item = data.LIST.INFO[i];
                                    var description = "";
                                    var amountGeneral = parseFloat(item.Amount) / 100;
                                    var simbolTrac = '';

                                    if (item.TranCode === Util.trans.DEBIT) {

                                        type = 'Debit';

                                        if (Util.countInArray(item.TicketNumber + '-' + item.ItemNumber, listTicket) === 0) {
                                            lossTotal += amountGeneral;
                                        }


                                        simbolTrac = '-';

                                    } else {

                                        type = 'Credit';

                                        if (Util.countInArray(item.TicketNumber + '-' + item.ItemNumber, listTicket) === 0) {
                                            wonTotal += amountGeneral;
                                        }



                                    }




                                    element = '<tr class= "header">' +
                                            '<td class="acceptedColumn leftAlign">' + $.format.date(item.DailyFigureDate, "E M/d hh:mm a") + "</td>" +
                                            '<td class="typeColumn leftAlign" ">' + type + "</td>" +
                                            '<td class="leftAlign" data-field="description">' + item.ShortDesc + "</td> " +
                                            "<td style='text-align: right;'>" +
                                            _self.drawWinLoss({val: simbolTrac + parseFloat(item.Amount / 100)}) +
                                            "</td>" +
                                            "</tr>";

                                    //------------------------------------------------------

                                    content.find("table#daily-table tbody").append(element);


                                    if (Util.countInArray(item.TicketNumber + '-' + item.ItemNumber, listTicket) === 0) {
                                        listTicket.push(item.TicketNumber);
                                    }

                                }

                            } else {

                                for (var i = 0; i < data.LIST.INFO.length; i++) {
                                    var item = data.LIST.INFO[i];
                                    var description = "";

                                    var gameTicketWagerNumber = item.TicketNumber + "-" + item.WagerNumber;


                                    //Valida que el juego no haya sido procesado anteriormente
                                    if (gameTicketWagerNumber != ticketWagerNumberTmp) {

                                        // Assign new ticket# and wager# to temporals variables
                                        ticketWagerNumberTmp = gameTicketWagerNumber;

                                        //--------------- Carga la informacion del tiquete -----------------------------------------------
                                        var statusStyle = '';

                                        if (item.TotalPicks > 1) {

                                            statusStyle = 'hidden';

                                        }

                                        var wagerDescriptionFormat =
                                                "<div data-group='" + item.TicketNumber + "-" + item.WagerNumber + "' class='hidden ticketNumberDescription'>" +
                                                "<div class='col-md-12 col-sm-12 col-xs-12'>" +
                                                "<div class='col-md-3 col-sm-3 col-xs-3 z2" + statusStyle + " '>" + "<label class='normalDescription'>{Header}</label>" + "</div>" +
                                                "<div class='col-md-9 col-sm-9 col-xs-9'>" +
                                                "<label class='normalDescription'>{Content}</label>" +
                                                "</div>" +
                                                "</div>" +
                                                "</div>";


                                        var rotationNumber = "";
                                        var statusDesc = _self.getWagerStatus({WagerStatus: item.Outcome});
                                        var wagerType = (item.WagerType === "C" ? "" : _self.getTypeInfo({item: item, birdCage: item.ARBirdcageLink, wagerType: item.WagerType, roundRobin: item.RoundRobinLink, ARLink: item.ARLink, totalPicks: item.totalPicks}));
                                        var gameTeams = "";
                                        var selection = "";

                                        var pitchers = '';

                                        if (item.ListedPitcher1 != null &&
                                                item.SportType.toString().trim().toUpperCase() === Util.SPORT.BASEBALL) {
                                            var stateR = _self.statePitcher({
                                                flag: item.Pitcher1ReqFlag
                                            });
                                            var stateL = _self.statePitcher({
                                                flag: item.Pitcher2ReqFlag
                                            });

                                            //--------------------------------------------------------------

                                            pitchers =
                                                    '<div class="pitcher-pending">' + item.ListedPitcher1 + " - " + stateR + " | " + item.ListedPitcher2 + " - " + stateL + "</div>";
                                        }


                                        if (item.Team1RotNum != 0) {
                                            rotationNumber = _self.getRotationNumber({Team1ID: item.Team1ID, ChosenTeamID: item.ChosenTeamID, Team1RotNum: item.Team1RotNum, Team2RotNum: item.Team2RotNum});
                                            statusDesc += " (" + item.Team1ID + " " + item.Team1FinalScore + "-" + item.Team2ID + " " + item.Team2FinalScore + ")";
                                            gameTeams = item.Team1ID + ' / ' + item.Team2ID;
                                            selection = item.SportSubType + " - " + ((item.LegWagerType === "L") ? item.Team1RotNum + " / " + item.Team2RotNum : rotationNumber) + "   " + item.PeriodDescription.trim() + " " + wagerType + pitchers;
                                        }

                                        var singleWagerType = "SMLEA"; // Contiene las siglas de las apuestas simples.

                                        var commentH = '';

                                        if (item.Comments !== null && item.Comments !== '') {
                                            commentH = wagerDescriptionFormat.replace("{Header}", ("Game Note :")).replace("{Content}", item.Comments);
                                        }


                                        // Multiple Wagers
                                        if (!singleWagerType.includes(item.WagerType) && item.WagerType != "C") {
                                            description += wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-38"}) + "#:")).replace("{Content}", "<label>" + item.TicketNumber + "</label>") +
                                                    wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-423"}) + ":")).replace("{Content}", statusDesc) +
                                                    wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-244"}) + "/" + Language.get({key: "L-393"}) + ":")).replace("{Content}", "<label>" + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.AmountWagered / 100}) + " / " + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.ToWinAmount / 100})) + "</label>" +
                                                    wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-206"}) + ":")).replace("{Content}", $.format.date(item.AcceptedDateTime.split(".")[0], "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT) +
                                                    wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-425"}) + ":")).replace("{Content}", item.TicketWriter.replace('BLR', 'RB')) +
                                                    //((item.Comments !== '') ? wagerDescriptionFormat.replace("{Header}", ("Game Note :")).replace("{Content}", item.Comments) : '');
                                                    commentH;

                                            //-------- Carga la informacion de los juegos --------    
                                            var wagerData = data.LIST.INFO.filter(function (el) {
                                                return el.TicketNumber == item.TicketNumber && el.WagerNumber == item.WagerNumber;
                                            });
                                            description += _self.getResultTicket(wagerData);

                                        } else {
                                            //-------- Carga la informacion de los juegos --------    
                                            var wagerData = data.LIST.INFO.filter(function (el) {
                                                return el.TicketNumber == item.TicketNumber && el.WagerNumber == item.WagerNumber;
                                            });
                                            description += _self.getResultTicket(wagerData);



                                            var commentH = '';

                                            if (item.Comments !== null && item.Comments !== '') {
                                                commentH = wagerDescriptionFormat.replace("{Header}", ("Game Note :")).replace("{Content}", item.Comments);
                                            }


                                            // Single Wagers
                                            if (item.WagerType != "C") {



                                                description += wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-38"}) + "#:")).replace("{Content}", "<label>" + item.TicketNumber + "</label>") +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-423"}) + ":")).replace("{Content}", statusDesc) +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-244"}) + "/" + Language.get({key: "L-393"}) + ":")).replace("{Content}", "<label>" + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.AmountWagered / 100}) + " / " + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.ToWinAmount / 100})) + "</label>" +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-237"}) + ":")).replace("{Content}", gameTeams) +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-424"}) + ":")).replace("{Content}", selection) +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-426"}) + ":")).replace("{Content}", $.format.date(item.GameDateTime.split(".")[0], "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT) +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-206"}) + ":")).replace("{Content}", $.format.date(item.AcceptedDateTime.split(".")[0], "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT) +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-425"}) + ":")).replace("{Content}", item.TicketWriter.replace('BLR', 'RB')) +
                                                        //((item.Comments !== '') ? wagerDescriptionFormat.replace("{Header}", ("Game Note :")).replace("{Content}", item.Comments) : '');
                                                        commentH;


                                            } else {
                                                //Contests
                                                description += wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-38"}) + "#:")).replace("{Content}", "<label>" + item.TicketNumber + "</label>") +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-423"}) + ":")).replace("{Content}", _self.getWagerStatus({WagerStatus: item.WagerStatus})) +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-244"}) + "/" + Language.get({key: "L-393"}) + ":")).replace("{Content}", "<label>" + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.AmountWagered / 100}) + " / " + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.ToWinAmount / 100})) + "</label>" +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-237"}) + ":")).replace("{Content}", item.Team2ID) +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-426"}) + ":")).replace("{Content}", $.format.date(item.GameDateTime.split(".")[0], "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT) +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-206"}) + ":")).replace("{Content}", $.format.date(item.AcceptedDateTime.split(".")[0], "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT) +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-425"}) + ":")).replace("{Content}", item.TicketWriter.replace('BLR', 'RB')) +
                                                        commentH;//((item.Comments !== '') ? wagerDescriptionFormat.replace("{Header}", ("Game Note :")).replace("{Content}", item.Comments) : '');
                                            }
                                        }
                                        //------------------------------------------------------

                                        if (item.WagerStatus == Util.status.OPEN) {
                                            openSpots = " <button " + ' data-action="open-spots" ' + " data-param=" + JSON.stringify(param) + ' data-type="' + item.WagerType + '" ' + 'class="btn btn-info btn-sm" >' + "( " + item.WagerCount + " ) Open Spots " + "</button>";
                                        }

                                        //------------------------------------------------------

                                        var amountLost = (item.AmountLost === null || item.AmountLost === undefined) ? 0 : parseFloat(item.AmountLost) / 100;
                                        var amountWon = (item.AmountWon === null || item.AmountWon === undefined) ? 0 : parseFloat(item.AmountWon) / 100;

                                        //------------------------------------------------------
                                        if (item.FreePlayFlag === "Y" && item.WagerStatus === "L") {

                                            if (Util.countInArray(item.TicketNumber + '-' + item.ItemNumber, listTicket) === 0) {
                                                wonTotal += 0;
                                                lossTotal += 0;
                                            }


                                        } else {

                                            if (Util.countInArray(item.TicketNumber + '-' + item.ItemNumber, listTicket) === 0) {

                                                wonTotal += (item.AmountWon === null || item.AmountWon === undefined) ? 0 : parseFloat(item.AmountWon) / 100;
                                                lossTotal += (item.AmountLost === null || item.AmountLost === undefined) ? 0 : parseFloat(item.AmountLost) / 100;
                                            }

                                        }

                                        //------------------------------------------------------

                                        var totalFactor = _self.getMathSing({Amount: (amountWon - amountLost)}) +
                                                (Math.abs(amountWon - amountLost).toFixed(2));

                                        var resultCValue = "<span data-free='" + item.FreePlayFlag + "' data-amount-t='" + totalFactor + "' "
                                                + "class='amount label {color} normal-weight'>{signal}{currency}{amount}</span>";


                                        if (item.FreePlayFlag === 'Y') {


                                            if (item.WagerStatus === 'L') {
                                                resultCValue = resultCValue
                                                        .replace("{color}", Util.setBackground(amountWon - amountLost)).replace("{currency}", Util.getCurrency(Customer.accountInfo.CurrencyCode))
                                                        .replace("{amount}", '-0.00')
                                                        .replace("{signal}", _self.getMathSing({Amount: (amountWon - amountLost)}));
                                            } else {
                                                resultCValue = resultCValue
                                                        .replace("{color}", Util.setBackground(amountWon - amountLost)).replace("{currency}", Util.getCurrency(Customer.accountInfo.CurrencyCode))
                                                        .replace("{amount}", Util.formatCurrency({val: Math.abs(amountWon - amountLost).toFixed(2)}))
                                                        .replace("{signal}", _self.getMathSing({Amount: (amountWon - amountLost)}));

                                            }




                                        } else {
                                            resultCValue = resultCValue
                                                    .replace("{color}", Util.setBackground(amountWon - amountLost)).replace("{currency}", Util.getCurrency(Customer.accountInfo.CurrencyCode))
                                                    .replace("{amount}", Util.formatCurrency({val: Math.abs(amountWon - amountLost).toFixed(2)}))
                                                    .replace("{signal}", _self.getMathSing({Amount: (amountWon - amountLost)}));

                                        }

                                        var freeP = '';

                                        if (item.FreePlayFlag == "Y") {
                                            freeP = '<span class="label label-primary freeplaySpan fix-t-4">FP</span>';
                                        }


                                        element = '<tr class= "header" data-ticket=' + item.TicketNumber + "-" + item.WagerNumber + ">" +
                                                '<td class="acceptedColumn leftAlign">' + $.format.date(item.AcceptedDateTime.split(".")[0], "E M/d hh:mm a") + "</td>" +
                                                '<td class="typeColumn leftAlign" data-wagerType="' + item.WagerType + '">' + _self.getTypeInfo({item: item, birdCage: item.ARBirdcageLink, wagerType: item.WagerType, roundRobin: item.RoundRobinLink, ARLink: item.ARLink, totalPicks: item.TotalPicks}) + "</td>" +
                                                '<td class="leftAlign" data-field="description">' + freeP + description + "</td> " +
                                                "<td>" +
                                                resultCValue +
                                                "</td>" +
                                                "</tr>";

                                        //------------------------------------------------------

                                        content.find("table#daily-table tbody").append(element);


                                    }


                                    if (Util.countInArray(item.TicketNumber + '-' + item.ItemNumber, listTicket) === 0) {
                                        //listTicket.push(item.TicketNumber);
                                    }
                                }
                            }

                            //--------------------------------------------------

                            for (var i = 0; i < data.LIST.LIVE_CASINO_POSTED.length; i++) { //--- RATON
                                var item = data.LIST.LIVE_CASINO_POSTED[i];

                                var type = '';

                                if (item.TranCode === Util.trans.DEBIT) {

                                    type = 'Debit';

                                } else {

                                    type = 'Credit';

                                }

                                var amount = item.Amount;

                                var style = 'danger';
                                var simbol = '-';


                                if (amount > 0) {
                                    style = 'success ';
                                    simbol = '';


                                }

                                if (item.TranCode === 'D') {
                                    style = 'danger';
                                    simbol = '-';

                                    lossTotal += amount / 100;
                                }

                                if (item.TranCode === 'C') {
                                    style = 'success';
                                    simbol = '+';

                                    wonTotal += amount / 100;
                                }

                                var action = '';

                                if (item.ShortDesc.toString().search(_self.buyOutKey) === 0) {

                                    var ticketDeleted = item.ShortDesc.toString().split('ticket')[1].toString().trim();

                                    action = 'data-action="get-delete-wager" ticket-trans="' + ticketDeleted + '"';

                                }


                                element = '<tr ' + action + ' class="header" >' +
                                        '<td class="acceptedColumn leftAlign">' + $.format.date(item.DailyFigureDate.split(".")[0], "E M/d hh:mm a") + "</td>" +
                                        '<td class="typeColumn leftAlign">' + type + "</td>" +
                                        '<td style="    padding-left: 38px;" class="leftAlign" data-field="description">' + item.ShortDesc + "</td> " +
                                        '<td >' +
                                        '<span ' +
                                        'data-amount-t="' + simbol + amount / 100 + '" ' +
                                        'class="amount poorka label label-' + style + ' normal-weight">' + simbol + Util.currency[Customer.accountInfo.CurrencyCode] + Util.formatCurrency({val: amount / 100}) + '</span> ' +
                                        "</td>" +
                                        "</tr>";

                                content.find("table#daily-table tbody").append(element);


                            }


                            //--------------------------------------------------


                            var footer = "<tfoot>" +
                                    "<tr>" +
                                    "<td></td>" +
                                    "<td></td>" +
                                    '<td class="rightAlign" data-language="L-144"><label>' + Language.get({key: "L-144"}) + "</label></td>" +
                                    "<td data-total-t=''></td>" +
                                    "</tr>1" +
                                    "</tfoot>";

                            content.find("table#daily-table").append(footer);

                            //----------------------------------------------------------

                            var winLossTotal = 0;

                            for (var i = 0; i < data.LIST.CASINO_POSTED.length; i++) {
                                var item = data.LIST.CASINO_POSTED[i];

                                //------------------------------------------------------

                                var winLoss = item.WinAmount - item.RiskAmount;
                                winLossTotal += winLoss / 100;

                                element = "<tr>" +
                                        //"<td >" + $.format.date(item.DailyFigureDate, "E M/d ") + "</td> " +
                                        "<td  style='text-align:left'>" + item.PlayDescription + "</td> " +
                                        "<td class='rightAlign'><span data-amount-t='" + Math.abs(winLoss / 100).toFixed(2) + "' class='span-total label " + Util.setBackground(winLoss) + " normal-weight'>" + _self.getMathSing({Amount: winLoss}) + Util.getCurrency(Customer.accountInfo.CurrencyCode) + " " + Math.abs(winLoss / 100).toFixed(2) + "</span></td> " +
                                        "</tr>";

                                //------------------------------------------------------

                                content.find("table#casino-table tbody").append(element);
                            }


                            //--------------------------------------------------

                            var footer =
                                    "<tfoot>" +
                                    "<tr>" +
                                    //"<td></td>" +
                                    '<td class="rightAlign tdCasinoTotal" data-language="L-144"><label>' + Language.get({key: "L-144"}) + "</label></td>" +
                                    '<td class="' + Util.isNP(winLossTotal) + ' rightAlign"><span class="span-total label ' + Util.setBackground(winLossTotal) + ' normal-weight"> ' + _self.getMathSing({Amount: winLossTotal}) + Util.getCurrency(Customer.accountInfo.CurrencyCode) + " " + Math.abs(winLossTotal).toFixed(2) + "</span></td>" +
                                    "</tr>" +
                                    "</tfoot>";

                            content.find("table#casino-table ").append(footer);

                            //----------------------------------------------------------

                            var totalLiveCasino = 0;
                            var fix = 1;
                            var amountLiveCasino = 0;

//                            for (var i = 0; i < data.LIST.LIVE_CASINO_POSTED.length; i++) {
//                                var item = data.LIST.LIVE_CASINO_POSTED[i];
//
//                                if (item.TranCode === Util.trans.DEBIT) {
//                                    fix = -1;
//                                } else {
//                                    fix = 1;
//                                }
//
//                                var amountLiveCasino = fix * (item.Amount);
//                                totalLiveCasino += amountLiveCasino;
//
//                                //------------------------------------------------------
//
//                                element =
//                                        "<tr>" +
//                                        "<td class='transactionColumn'>" + item.DocumentNumber + "</td> " +
//                                        "<td >" + item.ShortDesc + "</td> " +
//                                        '<td class="' + Util.isNP(amountLiveCasino) + ' rightAlign"><span class="span-total label ' + Util.setBackground(amountLiveCasino) + ' normal-weight">' + _self.getMathSing({Amount: amountLiveCasino}) + Util.getCurrency(Customer.accountInfo.CurrencyCode) + " " + Math.abs(amountLiveCasino / 100).toFixed(2) + "</span></td> " +
//                                        //"<td >" + $.format.date(item.DailyFigureDate, "E M/d ") + "</td> " +
//                                        "</tr>";
//                                //------------------------------------------------------
//
//                                content.find("table#live-casino-table tbody").append(element);
//                            }
//
//                            var footer =
//                                    "<tfoot>" +
//                                    "<tr>" +
//                                    //"<td></td>" +
//                                    "<td></td>" +
//                                    '<td class="rightAlign tdLiveCasinoTotal" data-language="L-144"><label>' + Language.get({key: "L-144"}) + "</label></td>" +
//                                    '<td class="' + Util.isNP(totalLiveCasino) + ' rightAlign"><span class="span-total label ' + Util.setBackground(totalLiveCasino) + ' normal-weight">' + _self.getMathSing({Amount: totalLiveCasino}) + Util.getCurrency(Customer.accountInfo.CurrencyCode) + " " + Math.abs(totalLiveCasino / 100).toFixed(2) + "</span></td>" +
//                                    "</tr>" +
//                                    "</tfoot>";
//
//                            content.find("table#live-casino-table ").append(footer);

                            //----------------------------------------------------------

                            _self.listeners();

                            //----------------------------------------------------------

                            UI.removeElement({
                                el: $('[data-page] [data-control="load"]'),
                                time: 1
                            });

                            $('[data-ticket]').each(function () {
                                var ticket = $(this).attr('data-ticket');
                                $('[data-ticket="' + ticket + '"]').not(':first').remove();
                            });

                            var totalFactor = 0;
                            $('[data-amount-t]').each(function () {
                                if ($(this).attr('data-free') === 'Y') {
                                    //data-free='"+ item.FreePlayFlag +"' 

                                    if (parseFloat($(this).attr('data-amount-t')) > 0) {
                                        totalFactor += parseFloat($(this).attr('data-amount-t'));
                                    }

                                } else {
                                    totalFactor += parseFloat($(this).attr('data-amount-t'));
                                }


                            });

                            var totalFactorHTML =
                                    "<span class='sa span-total label " + Util.setBackground(totalFactor) + " normal-weight'>" + _self.getMathSing({Amount: (totalFactor)}) + Util.getCurrency(Customer.accountInfo.CurrencyCode) + " " + Util.formatCurrency({val: Math.abs((totalFactor)).toFixed(2)}) + "</span>";

                            $('[data-total-t]').html(totalFactorHTML);


                            content.find('[data-action="get-delete-wager"]').on("click", function () {

                                UI.getComponent({
                                    component: "modal",
                                    func: _self.setDeleteWager,
                                    info: {
                                        ticketNumber: $(this).attr('ticket-trans'),
                                        self: _self
                                    }
                                });

                            });
                        }
                    });
                    //}
                },
                //----------------------------------------------------------------------
                drawWinLoss: function (options) {
                    var _customer = require("customer/customer");
                    var Customer = new _customer();
                    var defaults = {
                        trigger: false,
                        index: 0,
                        figure: [],
                        day: ''
                    };
                    var setting = $.extend(defaults, options);
                    var el = "0";
                    var figure = false;


                    var item = parseInt(setting.index) - 2;

                    //      console.log(options);

                    for (var i = 0; i < setting.figure.length; i++) {
                        if (setting.day == setting.figure[i] && options.val == 0) {
                            figure = true;
                        }
                    }



//                    if (Util.countInArray(setting.day.toString(), setting.figure) > 0) {
//                        figure = true;
//                    }



                    //------------------------------------------------------------------

                    if (parseFloat(options.val) > 0) {
                        el = '<span data-index="' + setting.index + '" data-trigger="' + setting.trigger + '" ' + 'class="label label-success normal-weight">' + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: options.val}) + "</span>";
                    }

                    //------------------------------------------------------------------

                    if (parseFloat(options.val) < 0) {
                        el = '<span data-index="' + setting.index + '" data-trigger="' + setting.trigger + '"  ' + 'class="label label-danger normal-weight">' + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: options.val}) + "</span>";
                    }

                    //------------------------------------------------------------------

                    if (parseInt(options.val) == 0) {
                        el = '<span style=" background: none; color: black; " data-index="' + setting.index + '" data-trigger="' + setting.trigger + '"  ' + 'class="label label-info">' + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: options.val}) + "</span>";
                        //el = 0;
                    }

                    //------------------------------------------------------------------

                    return el;
                },
                //----------------------------------------------------------------------
                detailItem: function (options) {
                    var item = options.item;
                    var bet = "";
                    var pitchers = "";
                    var line = "";
                    var itemNumber = "";
                    var outCome = "";
                    var status = "";

                    //------------------------------------------------------------------

                    switch (options.wagerType) {
                        case Util.BET.TYPE.PARLAY.char:
                        case Util.BET.TYPE.TEASER.char:
                        case Util.BET.TYPE.IF_BET.char:
                            //----------------------------------------------------------

                            switch (item.Outcome) {
                                case Util.status.OPEN:
                                    status = Language.get({key: "L-138"});
                                    break;

                                case Util.status.PENDING:
                                    status = Language.get({key: "L-233"});
                                    break;

                                case Util.status.WIN:
                                    status = Language.get({key: "L-71"});
                                    break;

                                case Util.status.LOSS:
                                    status = Language.get({key: "L-226"});
                                    break;
                            }

                            //----------------------------------------------------------

                            outCome =
                                    '<div class="col-md-3">' + Language.get({key: "L-234"}) + " :</div>" +
                                    '<div class="col-md-9">' + status + "</div>";

                            itemNumber =
                                    '<div class="col-md-12">Item #' + item.ItemNumber + "</div>";

                            break;

                        default:
                            break;
                    }

                    //------------------------------------------------------------------

                    if (options.wagerType !== Util.BET.SUB_TYPE.LIVE_BETTING.val) {
                        switch (item.WagerType) {
                            case Util.BET.SUB_TYPE.MONEY.val:
                                break;

                                //--------------------------------------------------

                            case Util.BET.SUB_TYPE.TOTAL.val:
                                line =
                                        (item.TotalPointsOU.toString().toLowerCase() == "o" ? "Over" : "Under") + " " + Util.isDecimal({number: item.AdjTotalPoints});

                                if (item.SportType.toString().toUpperCase().trim() == Util.SPORT.SOCCER) {
                                    line = Util.checkDisplayLine({sportType: item.SportType.toString().toUpperCase().trim(), line: parseFloat(item.AdjTotalPoints), odd: item.FinalMoney, lineType: Util.BET.SUB_TYPE.TOTAL.val, append: false, totalOU: item.TotalPointsOU});

                                }

                                //----------------------------------------------------------

                                if (options.wagerType == Util.BET.TYPE.TEASER.char) {
                                    var totalPoints = 0;

                                    //------------------------------------------------------

                                    if (item.TotalPointsOU.toString().toLowerCase() == "o") {
                                        totalPoints =
                                                parseFloat(item.AdjTotalPoints) -
                                                parseFloat(item.TeaserPoints);
                                    } else {
                                        totalPoints =
                                                parseFloat(item.AdjTotalPoints) +
                                                parseFloat(item.TeaserPoints);
                                    }

                                    //------------------------------------------------------

                                    line = (item.TotalPointsOU.toString().toLowerCase() == "o" ? "Over" : "Under") + " " + Util.isDecimal({number: totalPoints});
                                }

                                break;

                                //--------------------------------------------------

                            case Util.BET.SUB_TYPE.TEAM_TOTAL.val:
                                line = "Team Total " + (item.TotalPointsOU == "o" ? "Over" : "Under") + " " + Util.isDecimal({number: item.AdjTotalPoints});
                                break;

                                //--------------------------------------------------

                            case Util.BET.SUB_TYPE.SPREAD.val:
                                line = Util.isDecimal({number: item.AdjSpread});
                                line = Util.setSymbol({str: line});

                                //----------------------------------------------------------

                                if (item.SportType.toString().toUpperCase().trim() == Util.SPORT.SOCCER) {
                                    line = Util.checkDisplayLine({sportType: item.SportType.toString().toUpperCase().trim(), line: parseFloat(item.AdjSpread), odd: item.FinalMoney, lineType: Util.BET.SUB_TYPE.SPREAD.val, append: false});
                                }

                                //----------------------------------------------------------

                                if (options.wagerType == Util.BET.TYPE.TEASER.char) {
                                    var spreadPoints;

                                    //------------------------------------------------------

                                    spreadPoints = parseFloat(item.AdjSpread) + parseFloat(item.TeaserPoints);

                                    //------------------------------------------------------

                                    line = Util.isDecimal({
                                        number: Util.setSymbol({str: spreadPoints})
                                    });
                                }

                                break;
                        }

                        //------------------------------------------------------------------

                        var gameDate = $.format.date(item.GameDateTime, "E M/d hh:mm a");

                        if (item.ListedPitcher1 != null) {
                            var stateR = this.statePitcher({
                                flag: item.Pitcher1ReqFlag
                            });
                            var stateL = this.statePitcher({
                                flag: item.Pitcher2ReqFlag
                            });

                            //--------------------------------------------------------------

                            pitchers =
                                    '<div class="col-md-12">' + "Pitchers : " + item.ListedPitcher1 + " - " + stateR + " | " + item.ListedPitcher2 + " - " + stateL + "</div>";
                        }

                        //--------------------------------------------------------------

                        var finalMoney = Util.setSymbol({str: item.FinalMoney});

                        //---------------------------------------------------------------

                        if (options.wagerType == Util.BET.TYPE.TEASER.char) {
                            finalMoney = "";
                        }

                        //--------------------------------------------------------------

                        switch (Util.oddSelected) {
                            case Util.odds.DECIMAL:
                                finalMoney = item.FinalDecimal;
                                break;

                                //------------------------------------------------------

                            case Util.odds.FRACTIONAL:
                                finalMoney = item.FinalNumerator + Util.concat.FRACTIONAL + item.FinalDenominator;
                                break;
                        }

                        //--------------------------------------------------------------

                        bet =
                                '<div class="row">' + itemNumber + outCome + '<div class="col-md-3">' + Language.get({key: "L-235"}) + " / " + Language.get({key: "L-236"}) + ":</div>" +
                                '<div class="col-md-9">' +
                                '<div class="col-md-12">' + item.SportSubType + " " + item.SportType + " / " + item.PeriodDescription + " ( " + item.Team1ID + " : " + item.Team1FinalScore + " - " + item.Team2ID + " : " + item.Team2FinalScore + " )</div>" +
                                '<div class="col-md-12">' + item.ChosenTeamID + " | " + line + " " + finalMoney + "</div>" +
                                '<div class="col-md-12">' + Language.get({key: "L-237"}) + " " + Language.get({key: "L-184"}) + " : " + gameDate + "</div>" + pitchers +
                                '<div class="col-md-12">' + Language.get({key: "L-238"}) + " : </div>" +
                                '<div class="col-md-12">' + item.Comments + "</div>" +
                                "</div>" +
                                " </div>";
                    } else {
                        bet =
                                '<div class="row">' +
                                '<div class="col-md-5"><span data-language="223">' + Language.get({key: "L-223"}) + " :</span> </div>" +
                                '<div class="col-md-7">' + options.master.ToWinAmount / 100 + " </div>" +
                                '<div class="col-md-5"><span data-language="361">' + Language.get({key: "L-361"}) + " :</span> </div>" +
                                '<div class="col-md-7">' + options.master.WagerType / 100 + " </div>" + "</div>" +
                                '<div class="row">' +
                                '<div class="col-md-5"><span data-language="207">' + Language.get({key: "L-207"}) + " :</span> </div>" +
                                '<div class="col-md-7">' + options.description + " </div>" +
                                "</div>" +
                                "</div>";
                    }

                    return bet;
                },
                //----------------------------------------------------------------------
                detailTicket: function (options) {
                    var _customer = require("customer/customer");
                    var Customer = new _customer();

                    //------------------------------------------------------------------

                    var item = options.data.LIST[0];
                    var master = options.data.INFO;
                    var risk = master.AmountWagered / 100;
                    var win = master.ToWinAmount / 100;
                    var acceptedDate = $.format.date(master.AcceptedDateTime, "E M/d hh:mm a");
                    var wagerType = "";
                    var status = "";
                    var bet = "";

                    //------------------------------------------------------------------

                    switch (master.WagerStatus) {
                        case Util.status.OPEN:
                            status = Language.get({key: "L-138"});
                            break;

                            //----------------------------------------------------------

                        case Util.status.PENDING:
                            status = Language.get({key: "L-233"});
                            break;

                            //----------------------------------------------------------

                        case Util.status.WIN:
                            status = Language.get({key: "L-71"});
                            break;

                            //----------------------------------------------------------

                        case Util.status.LOSS:
                            status = Language.get({key: "L-226"});
                            break;

                            //----------------------------------------------------------

                        case Util.status.CANCEL:
                            status = Language.get({key: "L-239"});
                            break;
                    }

                    //------------------------------------------------------------------

                    switch (options.wagerType) {
                        case "P":
                        case "T":
                        case "I":
                            var type = "";

                            //----------------------------------------------------------

                            if (options.wagerType == "I") {
                                switch (master.ContinueOnPushFlag) {
                                    case "N":
                                        type = " | If win only";
                                        break;

                                        //----------------------------------------------

                                    case "Y":
                                        type = " | If win or push";
                                        break;
                                }
                            }

                            //----------------------------------------------------------

                            options.ARLink = master.ARLink;

                            //----------------------------------------------------------

                            wagerType = Util.getTypeInfo(options) + " ( " + options.data.LIST.length + " team " + type + " )";

                            //----------------------------------------------------------

                            if (options.wagerType == "T") {
                                wagerType = master.TeaserName + " ( " + master.totalPicks + " team " + type + " )";
                            }

                            //----------------------------------------------------------

                            for (var i = 0; i < options.data.LIST.length; i++) {
                                bet += this.detailItem({
                                    item: options.data.LIST[i],
                                    wagerType: options.wagerType,
                                    master: master,
                                    description: options.description
                                });
                            }

                            break;

                        case "C":
                            var contestDate = $.format.date(
                                    item.ContestDateTime,
                                    "E M/d hh:mm a"
                                    );

                            wagerType = Util.getTypeInfo(options);

                            bet =
                                    ' <div class="row">' +
                                    '<div class="col-md-3">Line :</div>' +
                                    '<div class="col-md-9">' +
                                    '<div class="col-md-12">' + item.ContestType + "</div>" +
                                    '<div class="col-md-12">' + item.ContestType2 + "</div>" +
                                    '<div class="col-md-12">' + item.ContestType3 + "</div>" +
                                    '<div class="col-md-12">' + item.ContestDesc + " | " + contestDate + " </div>" +
                                    '<div class="col-md-12">' + item.ContestantName + " " + Util.setSymbol({str: item.FinalMoney}) + " </div>" +
                                    '<div class="col-md-12">' + Language.get({key: "L-238"}) + " : </div>" + '<div class="col-md-12">' + item.Comments + " </div>" + "</div>" + " </div>";

                            break;

                        default:
                            wagerType = Util.getTypeInfo(options);

                            bet = this.detailItem({
                                item: item,
                                wagerType: options.wagerType,
                                master: master,
                                description: options.description
                            });

                            break;
                    }

                    //------------------------------------------------------------------

                    var el = ' <div class="container-fluid">' + ' <div class="row">' +
                            '<div class="col-md-5">' + Language.get({key: "L-13"}) + " :</div>" +
                            '<div class="col-md-7">' + wagerType + "</div>" +
                            '<div class="col-md-5">' + Language.get({key: "L-240"}) + " :</div>" +
                            '<div class="col-md-7">' + status + "</div>" +
                            '<div class="col-md-5">' + Language.get({key: "L-70"}) + " / " + Language.get({key: "L-71"}) + " :</div>" +
                            '<div class="col-md-7">' + risk + " / " + win + " (" + Util.currency[Customer.accountInfo.CurrencyCode] + ") " + acceptedDate + "</div>" +
                            "</div>" + bet + "</div>";

                    return el;
                },
                //----------------------------------------------------------------------
                getResultTicket: function (data) {
                    var element = "";
                    var _customer = require("customer/customer");
                    var Customer = new _customer();
                    var _self = this;


                    var principalFormat = "<div class='col-md-12 col-sm-12 col-xs-12 gameReport a1'>" +
                            "<label class='rotationNumber'>{RotationNumber}</label>" +
                            "<label> {chosenTeamId} </label>" +
                            "<label class='line'>{line}</label>" +
                            "<label data-status='{statusClass}'>{statusGame}</label>";

                    var headerFormat = "<div data-group='" + data[0].TicketNumber + "-" + data[0].WagerNumber + "'class='hidden'>" +
                            "<div class='col-md-12 col-sm-12 col-xs-12'>" +
                            "<div class='col-md-3 col-sm-3 col-xs-3 z3'>" +
                            "<label class='normalDescription'>{Header}</label>" +
                            "</div>" +
                            "<div class='col-md-9 col-sm-9 col-xs-9'>" +
                            "<label class='normalDescription'>{Content}</label>" +
                            "</div>" +
                            "</div>" +
                            "</div>";

                    var footerFormat = "</div>";

                    for (var i = 0; i < data.length; i++) {
                        //Calculate the status of the wager

                        var rotationNumber = "";
                        var period = "";
                        var selection = "";
                        var gameTeams = "";
                        var statusDesc = _self.getWagerStatus({WagerStatus: data[i].Outcome});
                        var choosenTeamId = data[i].ChosenTeamID;



                        if (data[i].TotalPointsOU !== null &&
                                data[i].WagerType === Util.BET.SUB_TYPE.TOTAL.val) {

                            choosenTeamId = data[i].Team1ID + '/' + data[i].Team2ID;

                        }

                        var line = _self.getLineGame({
                            WagerType: data[i].LegWagerType,
                            AdjSpread: data[i].AdjSpread,
                            FinalMoney: data[i].FinalMoney,
                            TotalPointsOU: data[i].TotalPointsOU,
                            AdjTotalPoints: data[i].AdjTotalPoints,
                            Description: data[i].Description,
                            SportType: data[i].SportType,
                            ChosenTeamID: data[i].ChosenTeamID,
                            Team1ID: data[i].Team1ID,
                            Team2ID: data[i].Team2ID,
                            TeaserPoints: data[i].TeaserPoints
                        });



                        if (data[i].Team1RotNum != 0) {
                            rotationNumber = _self.getRotationNumber({
                                Team1ID: data[i].Team1ID,
                                ChosenTeamID: data[i].ChosenTeamID,
                                Team1RotNum: data[i].Team1RotNum,
                                Team2RotNum: data[i].Team2RotNum
                            });


                            switch (data[i].LegWagerType) {

                                case  'S' :
                                    wagerType = ' Spread';
                                    break;

                                case  'M' :
                                    wagerType = ' Money Line';
                                    break;

                                case  'L' :
                                    wagerType = ' Total';
                                    break;

                                case  'E' :
                                    wagerType = ' Team Total';
                                    break;

                            }



                            statusDesc += "  (" + data[i].Team1ID + " " + data[i].Team1FinalScore + " - " + data[i].Team2ID + " " + data[i].Team2FinalScore + ")";
                            period = data[i].PeriodDescription.trim();
                            selection = data[i].SportSubType + " - " + ((data[i].LegWagerType === "L") ? data[i].Team1RotNum + " / " + data[i].Team2RotNum : rotationNumber) + " " + period + wagerType;
                            gameTeams = data[i].Team1ID + '/' + data[i].Team2ID;
                        }

                        var schedule = $.format.date(data[i].GameDateTime.toString(), "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT;
                        var wagerType = (data[i].LegWagerType === "C" ? "" : Util.getTypeInfo({birdCage: data[i].ARBirdcageLink, wagerType: data[i].WagerType, roundRobin: data[i].RoundRobinLink, ARLink: data[i].ARLink, totalPicks: data[i].totalPicks}));


                        var singleWagerType = "SMLEA"; // Contiene las siglas de las apuestas simples.

                        var subElement = "";

                        // Si es straigh bet solo formar encabezado
                        if (singleWagerType.includes(data[i].WagerType)) {

                            var periodDescription = '';

                            if (data[i].PeriodNumber > 0) {
                                periodDescription = ' - <span class="period-description-s">' + data[i].PeriodDescription.toString() + ' </span> ';
                            }

                            if (data[i].WagerType === 'A') {

                                subElement = principalFormat.replace("{RotationNumber}", rotationNumber)
                                        .replace("{chosenTeamId}", data[i].Description)
                                        .replace("{line}", line + periodDescription).replace("{statusGame}", "")
                                        .replace("{statusClass}", data[i].Outcome);

                            } else {
                                subElement = principalFormat.replace("{RotationNumber}", rotationNumber)
                                        .replace("{chosenTeamId}", choosenTeamId)
                                        .replace("{line}", line + periodDescription).replace("{statusGame}", "")
                                        .replace("{statusClass}", data[i].Outcome);

                            }



                        } else {

                            if (data[i].WagerType === "C") {

                                var tipo = data[i].Team2ID.trim();
                                var line = _self.getLineGame({
                                    WagerType: data[i].LegWagerType,
                                    AdjSpread: data[i].AdjSpread,
                                    FinalMoney: data[i].FinalMoney,
                                    TotalPointsOU: data[i].TotalPointsOU,
                                    AdjTotalPoints: data[i].AdjTotalPoints,
                                    Description: data[i].Description,
                                    SportType: data[i].SportType,
                                    ChosenTeamID: data[i].ChosenTeamID,
                                    Team1ID: data[i].Team1ID,
                                    Team2ID: data[i].Team2ID
                                });


                                var principalFormat = "<div class='col-md-12 col-sm-12 col-xs-12 gameReport a2'>" +
                                        "<label class='normalDescription'>{tipo}</label> - " +
                                        "<label>{equipo}</label>" +
                                        "<label class='line'>{line}</label>";


                                subElement =
                                        principalFormat.replace("{tipo}", tipo)
                                        .replace("{equipo}", data[i].ChosenTeamID)
                                        .replace("{line}", line);
                                // footerFormat;

                            } else {


                                var periodDescription = '';

                                if (data[i].PeriodNumber > 0) {
                                    periodDescription = ' - <span class="period-description-s">' + data[i].PeriodDescription.toString() + ' </span> ';
                                }

                                var statusGeneral = _self.getWagerStatus({WagerStatus: data[i].Outcome});

                                if (data[i].WagerType === 'G') {
                                    choosenTeamId = data[i].Description;
                                    statusGeneral = '';

                                    if (data[i].WagerStatus === 'W') {
                                        statusDesc = 'Won';
                                    }

                                    if (data[i].WagerStatus === 'L') {
                                        statusDesc = 'Loss';
                                    }

                                    subElement =
                                            principalFormat.replace("{RotationNumber}", rotationNumber).replace("{chosenTeamId}", choosenTeamId)
                                            .replace("{line}", line + periodDescription).replace("{statusGame}", statusGeneral)
                                            .replace("{statusClass}", data[i].Outcome) +
                                            headerFormat.replace("{Header}", (Language.get({key: "L-423"}) + ":")).replace("{Content}", statusDesc) +
                                            headerFormat.replace("{Header}", (Language.get({key: "L-237"}) + ":")).replace("{Content}", '') +
                                            headerFormat.replace("{Header}", (Language.get({key: "L-424"}) + ":")).replace("{Content}", '') +
                                            headerFormat.replace("{Header}", (Language.get({key: "L-426"}) + ":")).replace("{Content}", '') +
                                            //headerFormat.replace("{Header}", (Language.get({ key: "L-427" }) + ":")).replace("{Content}", data[i].Comments) +
                                            footerFormat;


                                } else {

                                    var pitchers = '';

                                    if (data[i].ListedPitcher1 != null &&
                                            data[i].SportType.toString().trim().toUpperCase() === Util.SPORT.BASEBALL) {
                                        var stateR = this.statePitcher({
                                            flag: data[i].Pitcher1ReqFlag
                                        });
                                        var stateL = this.statePitcher({
                                            flag: data[i].Pitcher2ReqFlag
                                        });

                                        //--------------------------------------------------------------

                                        pitchers =
                                                '<div class="pitcher-pending">' + data[i].ListedPitcher1 + " - " + stateR + " | " + data[i].ListedPitcher2 + " - " + stateL + "</div>";
                                    }

                                    var comments = '';

                                    if (data[i].Comments !== '' && data[i].Comments !== null) {
                                        comments = headerFormat.replace("{Header}", (Language.get({key: "L-427"}) + ":")).replace("{Content}", data[i].Comments);
                                    }

                                    //------------------------------------------

                                    if (data[i].WagerType === Util.BET.TYPE.TEASER.char) {

                                        if (data[i].TotalPointsOU !== null
                                                &&
                                                data[i].LegWagerType === 'L'
                                                ) {

                                            var totalPoints = 0;

                                            //------------------------------------------------------

                                            if (data[i].TotalPointsOU.toString().toLowerCase() == "o") {
                                                totalPoints =
                                                        parseFloat(data[i].AdjTotalPoints) -
                                                        parseFloat(data[i].TeaserPoints);
                                            } else {
                                                totalPoints =
                                                        parseFloat(data[i].AdjTotalPoints) +
                                                        parseFloat(data[i].TeaserPoints);
                                            }

                                            line = data[i].TotalPointsOU.toString() + ' ' + totalPoints;

                                        } else {

                                            var spreadPoints;

                                            //------------------------------------------------------

                                            spreadPoints = parseFloat(data[i].AdjSpread) + parseFloat(data[i].TeaserPoints);

                                            //------------------------------------------------------

                                            line = Util.isDecimal({
                                                number: Util.setSymbol({str: spreadPoints})
                                            });

                                            // console.log(line);

                                        }
                                    }

                                    //------------------------------------------


                                    subElement =
                                            principalFormat.replace("{RotationNumber}", rotationNumber).replace("{chosenTeamId}", choosenTeamId)
                                            .replace("{line}", line + periodDescription).replace("{statusGame}", statusGeneral)
                                            .replace("{statusClass}", data[i].Outcome) +
                                            headerFormat.replace("{Header}", (Language.get({key: "L-423"}) + ":")).replace("{Content}", statusDesc) +
                                            headerFormat.replace("{Header}", (Language.get({key: "L-237"}) + ":")).replace("{Content}", gameTeams) +
                                            headerFormat.replace("{Header}", (Language.get({key: "L-424"}) + ":")).replace("{Content}", selection + ' ' + pitchers) +
                                            headerFormat.replace("{Header}", (Language.get({key: "L-426"}) + ":")).replace("{Content}", schedule) +
                                            comments +
                                            footerFormat;


                                }


                            }
                        }
                        element += subElement;
                    }
                    return element;
                },
                //----------------------------------------------------------------------
                getResultTicketPending: function (data) {
                    var element = "";
                    var _customer = require("customer/customer");
                    var Customer = new _customer();
                    var _self = this;


                    if (data[0].WagerType == 'C' || data[0].WagerType == 'A') {
                        var principalFormat = "<div class='col-md-12 col-sm-12 col-xs-12 gameReport a3'>" +
                                "<label class='normalDescription'>{tipo}</label> - " +
                                "<label>{equipo}</label>" +
                                "<label class='line'>{line}</label>";

                        if (data[0].WagerType == 'A') {
                            var principalFormat = "<div class='col-md-12 col-sm-12 col-xs-12 gameReport a4'>" +
                                    "<label class='normalDescription'>{tipo}</label> " +
                                    "<label>{equipo}</label>" +
                                    "<label class='line'>{line}</label>";
                        }


                    } else {
                        var principalFormat = " <div class='col-md-12 col-sm-12 col-xs-12 gameReport REPORT-SNAKE a5'>" +
                                "<label class='rotationNumber'>{RotationNumber}</label>" +
                                "<label> {chosenTeamId} </label>" +
                                "<label class='line'>{line}</label>" +
                                "<label data-status='{statusClass}'>{statusGame}</label>";
                    }

                    var headerFormat = "<div data-group='" + data[0].TicketNumber + "-" + data[0].WagerNumber + "'class='hidden'>" +
                            "<div class='col-md-12 col-sm-12 col-xs-12'>" +
                            "<div class='col-md-2 col-sm-2 col-xs-2'>" +
                            "<label class='normalDescription'>{Header}</label>" +
                            "</div>" +
                            "<div class='col-md-10 col-sm-10 col-xs-10'>" +
                            "<label class='normalDescription'>{Content}</label>" +
                            "</div>" +
                            "</div>" +
                            "</div>";

                    var footerFormat = "</div><br>";


                    for (var i = 0; i < data.length; i++) {
                        var rotationNumber = _self.getRotationNumber({Team1ID: data[i].Team1ID, ChosenTeamID: data[i].ChosenTeamID, Team1RotNum: data[i].Team1RotNum, Team2RotNum: data[i].Team2RotNum});
                        var choosenTeamId = data[i].ChosenTeamID;

                        //var choosenTeamId = data[i].Team1ID + "/" + data[i].Team2ID;

                        if (data[i].LegWagerType === 'L') {
                            choosenTeamId = data[i].Team1ID + "/" + data[i].Team2ID;
                        }


                        var line = _self.getLineGame({

                            TeaserPoints: data[i].TeaserPoints,
                            WagerType: data[i].LegWagerType, AdjSpread: data[i].AdjSpread, FinalMoney: data[i].FinalMoney, TotalPointsOU: data[i].TotalPointsOU, AdjTotalPoints: data[i].AdjTotalPoints, Description: data[i].Description, SportType: data[i].SportType, ChosenTeamID: data[i].ChosenTeamID, Team1ID: data[i].Team1ID, Team2ID: data[i].Team2ID});


                        //------------------------------------------------------

                        var statusDesc = _self.getWagerStatus({WagerStatus: data[i].Outcome}) + "  (" + data[i].Team1ID + " " + ((data[i].Team1FinalScore == null) ? '0' : data[i].Team1FinalScore) + " - " + data[i].Team2ID + " " + ((data[i].Team2FinalScore == null) ? '0' : data[i].Team2FinalScore) + ")";
                        var period = data[i].PeriodDescription.trim();
                        var game = data[i].Team1ID.trim() + " / " + data[i].Team2ID.trim();
                        var schedule = $.format.date(data[i].GameDateTime.toString(), "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT;
                        var wagerType = _self.getTypeInfo({item: data[i], birdCage: data[i].ARBirdcageLink, wagerType: data[i].LegWagerType, roundRobin: data[i].RoundRobinLink, ARLink: data[i].ARLink, totalPicks: data[i].totalPicks});
                        var selection = ((data[i].LegWagerType === 'L') ? data[i].Team1RotNum + ' / ' + data[i].Team2RotNum : rotationNumber) + " " + period + " " + wagerType;
                        var statusGame = _self.getWagerStatus({WagerStatus: data[i].Outcome});

                        var item = data[i];

                        var pitcher = '';

                        switch (item.SportType.toString().toUpperCase().trim()) {

                            case Util.SPORT.BASEBALL:

                                if (item.ListedPitcher1 !== null) {

                                    pitcher = '<br><div class="pitcher-pending">( ' +
                                            item.ListedPitcher1 + ' ' + Util.pitcherAction({type: item.Pitcher1ReqFlag}) + ' / ' +
                                            item.ListedPitcher2 + ' ' + Util.pitcherAction({type: item.Pitcher2ReqFlag}) + ' )</div>';
                                }

                                break;
                        }

                        selection += pitcher;
                        var singleWagerType = "SMLEA"; // Contiene las siglas de las apuestas simples.

                        var subElement = "";

                        if (data[i].WagerType === 'G') {

                            rotationNumber = data[i].Description;
                        }

                        // Si es straigh bet solo formar encabezado
                        if (singleWagerType.includes(data[i].WagerType)) {

                            var periodDescription = '';

                            if (data[i].PeriodNumber > 0) {
                                periodDescription = ' - <span class="period-description-s">' + data[i].PeriodDescription.toString() + ' </span> ';
                            }

                            if (data[i].WagerType == 'A') {

                                subElement = principalFormat.replace("{tipo}", data[i].Description)
                                        .replace("{equipo}", '')
                                        .replace("{line}", '');

                            } else {
                                subElement = principalFormat.replace("{RotationNumber}", rotationNumber)
                                        .replace("{chosenTeamId}", choosenTeamId)
                                        .replace("{line}", line + periodDescription)
                                        .replace("{statusGame}", statusGame)
                                        .replace("{statusClass}", data[i].Outcome)
                                        .replace("{statusGame}", statusGame);

                            }




                        } else {

                            if (data[i].WagerType == 'C' || data[i].WagerType == 'A') {

                                var tipo = data[i].Team2ID.trim();
                                // var line = _self.getLineGame({WagerType: data[i].LegWagerType, AdjSpread: data[i].AdjSpread, FinalMoney: data[i].FinalMoney, TotalPointsOU: data[i].TotalPointsOU, AdjTotalPoints: data[i].AdjTotalPoints, Description: data[i].Description, SportType: data[i].SportType, ChosenTeamID: data[i].ChosenTeamID, Team1ID: data[i].Team1ID, Team2ID: data[i].Team2ID});

                                var line = Util.setSymbol({str: data[i].FinalMoney});

                                subElement = principalFormat.replace("{tipo}", tipo)
                                        .replace("{equipo}", data[i].ChosenTeamID)
                                        .replace("{line}", line);




                            } else {


                                if (data[i].WagerType === Util.BET.TYPE.TEASER.char) {

                                    if (data[i].TotalPointsOU !== null) {

                                        var totalPoints = 0;

                                        //------------------------------------------------------

                                        if (data[i].TotalPointsOU.toString().toLowerCase() == "o") {
                                            totalPoints =
                                                    parseFloat(data[i].AdjTotalPoints) -
                                                    parseFloat(data[i].TeaserPoints);
                                        } else {
                                            totalPoints =
                                                    parseFloat(data[i].AdjTotalPoints) +
                                                    parseFloat(data[i].TeaserPoints);
                                        }

                                        line = data[i].TotalPointsOU.toString() + ' ' + totalPoints;

                                    } else {

                                        var spreadPoints;

                                        //------------------------------------------------------

                                        spreadPoints = parseFloat(data[i].AdjSpread) + parseFloat(data[i].TeaserPoints);

                                        //------------------------------------------------------

                                        line = Util.isDecimal({
                                            number: Util.setSymbol({str: spreadPoints})
                                        });

                                    }


                                }

                                var periodDescription = '';

                                if (data[i].PeriodNumber > 0) {

                                    periodDescription = ' - <span class="period-description-s">' + data[i].PeriodDescription.toString() + ' </span> ';

                                }


                                if (data[i].WagerType === 'G') {
                                    subElement = principalFormat.replace("{RotationNumber}", rotationNumber)
                                            .replace("{chosenTeamId}", choosenTeamId)
                                            .replace("{line}", line + periodDescription)
                                            .replace("{statusGame}", statusGame)
                                            .replace("{statusClass}", data[i].Outcome)
                                            .replace("{statusGame}", statusGame) +
                                            headerFormat.replace("{Header}", (Language.get({key: "L-423"}) + ":")).replace("{Content}", statusDesc) +
                                            headerFormat.replace("{Header}", (Language.get({key: "L-237"}) + ":")).replace("{Content}", '') +
                                            headerFormat.replace("{Header}", (Language.get({key: "L-424"}) + ":")).replace("{Content}", '') +
                                            headerFormat.replace("{Header}", (Language.get({key: "L-426"}) + ":")).replace("{Content}", '') +
                                            footerFormat;
                                } else {

                                    var commentH = '';

                                    if (data[i].Comments !== null && data[i].Comments !== '') {
                                        commentH = headerFormat.replace("{Header}", ("Game Note :")).replace("{Content}", data[i].Comments);
                                    }


                                    subElement = principalFormat.replace("{RotationNumber}", rotationNumber)
                                            .replace("{chosenTeamId}", choosenTeamId)
                                            .replace("{line}", line + periodDescription)
                                            .replace("{statusGame}", statusGame)
                                            .replace("{statusClass}", data[i].Outcome)
                                            .replace("{statusGame}", statusGame) +
                                            headerFormat.replace("{Header}", (Language.get({key: "L-423"}) + ":")).replace("{Content}", statusDesc) +
                                            headerFormat.replace("{Header}", (Language.get({key: "L-237"}) + ":")).replace("{Content}", game) +
                                            headerFormat.replace("{Header}", (Language.get({key: "L-424"}) + ":")).replace("{Content}", selection) +
                                            headerFormat.replace("{Header}", (Language.get({key: "L-426"}) + ":")).replace("{Content}", schedule) +
                                            commentH +
                                            footerFormat;
                                }


                            }

                        }
                        element += subElement;
                    }
                    return element;
                },
                //----------------------------------------------------------------------
                _getResultTicketMobile: function (data) {

                    var element = "";
                    var openSpots = "";
                    var _customer = require("customer/customer");
                    var Customer = new _customer();
                    var _self = this;
                    var singleWagerType = "SMLECA";

                    if (data[0].WagerType == 'C' || data[0].WagerType == 'A') {

                        var HeaderContest = "<div class='col-md-12 col-sm-12 col-xs-12 wagerPendingMobile j2'>" +
                                "<label>{equipo}</label>" +
                                "<label class='line'>{line}</label>" +
                                "</div>";

                        if (data[0].WagerType == 'A') {
                            var HeaderContest = "<div class='col-md-12 col-sm-12 col-xs-12 wagerPendingMobile j3'>" +
                                    "<label>{equipo}</label>" +
                                    "</div>";
                        }


                    } else {

                        if (singleWagerType.includes(data[0].WagerType)) {
                            var descriptionFormat = "<div class='col-md-12 col-sm-12 col-xs-12 wagerPendingMobile j4'>" +
                                    "<div class='choosen cha-1'>" +
                                    "<img class='team-logo not-after {@not-logo}' src='@path'/>" +
                                    "<label>{@choosenTeam}</label>" +
                                    "<label class='line'>{@line}</label>" +
                                    "</div>" +
                                    "</div>";

                        } else {

                            var descriptionFormat = "<div class='col-md-12 col-sm-12 col-xs-12 wagerPendingMobile j5' data-group=" + data[0].TicketNumber + '-' + data[0].WagerNumber + '>' +
                                    "<div class='choosen cha-2'>" +
                                    "<img class='team-logo not-after {@not-logo}' src='@path'/>" +
                                    "<label>{@choosenTeam}</label>" +
                                    "<label class='line'>{@line}</label>" +
                                    "</div>" +
                                    "</div>";

                        }
                    }

                    var headerFormat = "<div data-group='" + data[0].TicketNumber + "-" + data[0].WagerNumber + "'class='hidden'>" +
                            "<div class='col-md-12 col-sm-12 col-xs-12'>" +
                            "<div class='col-md-3 col-sm-3 col-xs-3'>" +
                            "<label class='normalDescription'>{Header}</label>" +
                            "</div>" +
                            "<div class='col-md-9 col-sm-9 col-xs-9'>" +
                            "<label class='normalDescription'>{Content}</label>" +
                            "</div>" +
                            "</div>" +
                            "</div>";



                    for (var i = 0; i < data.length; i++) {

                        var item = data[i];

                        var wagerDescriptionFormat =
                                "<div data-group='" + item.TicketNumber + "-" + item.WagerNumber + "' class='hidden ticketNumberDescription'>" +
                                "<div class='col-md-12 col-sm-12 col-xs-12 wagerPendingMobile j7'>" +
                                "<div class='col-md-6 col-sm-6 col-xs-6'>" +
                                "<label class=normalDescription>{Header}</label>" +
                                "</div>" +
                                "<div class='col-md-6 col-sm-6 col-xs-6'>" +
                                "<label class=normalDescription>{Content}</label>" +
                                "</div>" +
                                "</div>" +
                                "</div>";

                        var singleWagerType = "SMLEA";
                        var logo = _self.getLogonMobile({Team1ID: data[i].Team1ID, Team2ID: data[i].Team2ID, ChosenTeamID: data[i].ChosenTeamID, ShortName1: data[i].ShortName1, ShortName2: data[i].ShortName2, LogoTeam1: data[i].LogoTeam1, LogoTeam2: data[i].LogoTeam2});
                        var description = _self.getDescriptionMobile({Team1ID: data[i].Team1ID, Team2ID: data[i].Team2ID, ChosenTeamID: data[i].ChosenTeamID, ShortName1: data[i].ShortName1, ShortName2: data[i].ShortName2, info: data[i]});


                        var rotationNumber = _self.getRotationNumber({Team1ID: data[i].Team1ID, ChosenTeamID: data[i].ChosenTeamID, Team1RotNum: data[i].Team1RotNum, Team2RotNum: data[i].Team2RotNum});
                        var choosenTeamId = data[i].Team1ID + "/" + data[i].Team2ID;
                        var line = _self.getLineGame({
                            TeaserPoints: data[i].TeaserPoints,
                            WagerType: data[i].LegWagerType, AdjSpread: data[i].AdjSpread, FinalMoney: data[i].FinalMoney, TotalPointsOU: data[i].TotalPointsOU, AdjTotalPoints: data[i].AdjTotalPoints, Description: data[i].Description, SportType: data[i].SportType, ChosenTeamID: data[i].ChosenTeamID, Team1ID: data[i].Team1ID, Team2ID: data[i].Team2ID});

                        var periodDescription = '';


                        var statusDesc = _self.getWagerStatus({WagerStatus: data[i].WagerStatus}) + "  (" + data[i].Team1ID + " " + ((data[i].Team1FinalScore == null) ? '0' : data[i].Team1FinalScore) + " - " + data[i].Team2ID + " " + ((data[i].Team2FinalScore == null) ? '0' : data[i].Team2FinalScore) + ")";
                        var period = data[i].PeriodDescription.trim();
                        var schedule = $.format.date(data[i].AcceptedDateTime.toString(), "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT;
                        var wagerType = (data[i].WagerType === "C" ? "" : _self.getTypeInfo({item: item, birdCage: data[i].ARBirdcageLink, wagerType: data[i].WagerType, roundRobin: data[i].RoundRobinLink, ARLink: data[i].ARLink, totalPicks: data[i].totalPicks}));
                        var selection = rotationNumber + " " + period + " " + wagerType;
                        var singleWagerType = "SMLEA"; // Contiene las siglas de las apuestas simples.
                        var subElement = "";

                        var notLogo = '';


                        if (data[i].TotalPointsOU !== null) {

                            notLogo = 'not-logo';

                        }


                        if (description.toString().indexOf('/') != -1) {

                            notLogo = 'not-logo';

                        }

                        if (data[i].WagerType == 'C') {
                            line = data[i].FinalMoney > 0 ? '+' + data[i].FinalMoney : data[i].FinalMoney;
                        }


                        // Si es straigh bet solo formar encabezado
                        if (singleWagerType.includes(data[i].WagerType)) {

                            var periodDescription = '';

                            if (data[i].PeriodNumber > 0) {
                                periodDescription = ' - <span class="period-description-s">' + Util.periodAbrev[data[i].PeriodNumber];
                                +' </span> ';
                            }

                            subElement = descriptionFormat.replace("@path", logo)
                                    .replace("{@choosenTeam}", description)
                                    .replace("{@not-logo}", notLogo)
                                    .replace("{@line}", line + periodDescription);

                        } else {

                            if (data[i].WagerType == 'C' || data[i].WagerType == 'A') {
                                var tipo = data[i].Team2ID.trim() + ' ' + data[i].ChosenTeamID;
                                subElement = HeaderContest.replace("{equipo}", tipo)
                                        .replace("{line}", line);


                                if (data[i].WagerType == 'A') {

                                    var tipo = data[i].Description.trim();
                                    subElement = HeaderContest.replace("{equipo}", tipo)
                                            .replace("{line}", '');

                                }




                            } else {

                                if (data[i].WagerType === Util.BET.TYPE.TEASER.char) {

                                    if (data[i].TotalPointsOU !== null) {

                                        var totalPoints = 0;

                                        //------------------------------------------------------

                                        if (data[i].TotalPointsOU.toString().toLowerCase() == "o") {
                                            totalPoints =
                                                    parseFloat(data[i].AdjTotalPoints) -
                                                    parseFloat(data[i].TeaserPoints);
                                        } else {
                                            totalPoints =
                                                    parseFloat(data[i].AdjTotalPoints) +
                                                    parseFloat(data[i].TeaserPoints);
                                        }

                                        line = data[i].TotalPointsOU.toString() + ' ' + totalPoints;
                                        ;

                                    } else {

                                        var spreadPoints;

                                        //------------------------------------------------------

                                        spreadPoints = parseFloat(data[i].AdjSpread) + parseFloat(data[i].TeaserPoints);

                                        //------------------------------------------------------

                                        line = Util.isDecimal({
                                            number: Util.setSymbol({str: spreadPoints})
                                        });


                                        var periodDescription = '';

                                        if (data[i].PeriodNumber > 0) {
                                            periodDescription = ' - <span class="period-description-s">' + Util.periodAbrev[data[i].PeriodNumber];
                                            +' </span> ';
                                        }

                                    }


                                }

                                if (data[i].WagerType === 'G') {

                                    description = data[i].Description;

                                }

                                var periodDescription = '';

                                if (data[i].PeriodNumber > 0) {
                                    periodDescription = ' - <span class="period-description-s">' + Util.periodAbrev[data[i].PeriodNumber];
                                    +' </span> ';
                                }

                                subElement = descriptionFormat.replace("@path", logo)
                                        .replace("{@choosenTeam}", description)
                                        .replace("{@not-logo}", notLogo)
                                        .replace("{@line}", line + periodDescription);

                            }

                        }
                        element += subElement;
                    }
                    return element;
                },
                getResultTicketMobile: function (data) {

                    var element = "";
                    var openSpots = "";

                    var _customer = require("customer/customer");
                    var Customer = new _customer();

                    var _self = this;
                    var singleWagerType = "SMLECA";

                    if (data[0].WagerType == 'C' || data[0].WagerType === 'A') {

                        var HeaderContest = "<div class='col-md-12 col-sm-12 col-xs-9 wagerPendingMobile type-content-" + data[0].WagerType + "'>" +
                                "<label>{equipo}</label>" +
                                "<label class='line {line-type}'>{line}</label>" +
                                "</div>";
                    } else {

                        if (singleWagerType.includes(data[0].WagerType)) {
                            var descriptionFormat = "<div class='col-md-12 col-sm-12 col-xs-9 wagerPendingMobile type-content-" + data[0].WagerType + "'>" +
                                    "<div class='choosen cha-1'>" +
                                    "<img class='team-logo not-after {@not-logo}' src='@path'/>" +
                                    "<label>{@choosenTeam}</label>" +
                                    "<label class='line {line-type}'>{@line}</label>" +
                                    "</div>" +
                                    "</div>";

                        } else {

                            var descriptionFormat = "<div class='col-md-12 col-sm-12 col-xs-9 wagerPendingMobile type-content-" + data[0].WagerType + "' data-group=" + data[0].TicketNumber + '-' + data[0].WagerNumber + '>' +
                                    "<div class='choosen cha-2'>" +
                                    "<img class='team-logo not-after {@not-logo}' src='@path'/>" +
                                    "<label>{@choosenTeam}</label>" +
                                    "<label class='line {line-type}'>{@line}</label>" +
                                    "<label data-status='{statusClass}'>{statusGame}</label>" +
                                    "</div>" +
                                    "</div>";

                        }
                    }

                    var headerFormat = "<div data-group='" + data[0].TicketNumber + "-" + data[0].WagerNumber + "'class='hidden'>" +
                            "<div class='col-md-12 col-sm-12 col-xs-12'>" +
                            "<div class='col-md-3 col-sm-3 col-xs-3'>" +
                            "<label class='normalDescription'>{Header}</label>" +
                            "</div>" +
                            "<div class='col-md-9 col-sm-9 col-xs-9'>" +
                            "<label class='normalDescription'>{Content}</label>" +
                            "</div>" +
                            "</div>" +
                            "</div>";



                    for (var i = 0; i < data.length; i++) {

                        var item = data[i];

                        var wagerDescriptionFormat =
                                "<div data-group='" + item.TicketNumber + "-" + item.WagerNumber + "' class='hidden ticketNumberDescription'>" +
                                "<div class='col-md-12 col-sm-12 col-xs-12 wagerPendingMobile ESPONJA-A'>" +
                                "<div class='col-md-6 col-sm-6 col-xs-6'>" +
                                "<label class=normalDescription>{Header}</label>" +
                                "</div>" +
                                "<div class='col-md-6 col-sm-6 col-xs-6'>" +
                                "<label class=normalDescription>{Content}</label>" +
                                "</div>" +
                                "</div>" +
                                "</div>";

                        var singleWagerType = "SMLEA";
                        var logo = _self.getLogonMobile({Team1ID: data[i].Team1ID, Team2ID: data[i].Team2ID, ChosenTeamID: data[i].ChosenTeamID, ShortName1: data[i].ShortName1, ShortName2: data[i].ShortName2, LogoTeam1: data[i].LogoTeam1, LogoTeam2: data[i].LogoTeam2});

                        var description = _self.getDescriptionMobile({Team1ID: data[i].Team1ID, Team2ID: data[i].Team2ID, ChosenTeamID: data[i].ChosenTeamID, ShortName1: data[i].ShortName1, ShortName2: data[i].ShortName2, info: data[i]});


                        var rotationNumber = _self.getRotationNumber({Team1ID: data[i].Team1ID, ChosenTeamID: data[i].ChosenTeamID, Team1RotNum: data[i].Team1RotNum, Team2RotNum: data[i].Team2RotNum});
                        var choosenTeamId = data[i].Team1ID + "/" + data[i].Team2ID;
                        var line = _self.getLineGame({

                            WagerType: data[i].LegWagerType, AdjSpread: data[i].AdjSpread, FinalMoney: data[i].FinalMoney, TotalPointsOU: data[i].TotalPointsOU, AdjTotalPoints: data[i].AdjTotalPoints, Description: data[i].Description, SportType: data[i].SportType, ChosenTeamID: data[i].ChosenTeamID, Team1ID: data[i].Team1ID, Team2ID: data[i].Team2ID, TeaserPoints: data[i].TeaserPoints});

                        var periodDescription = '';


                        var statusDesc = _self.getWagerStatus({WagerStatus: data[i].WagerStatus}) + "  (" + data[i].Team1ID + " " + ((data[i].Team1FinalScore == null) ? '0' : data[i].Team1FinalScore) + " - " + data[i].Team2ID + " " + ((data[i].Team2FinalScore == null) ? '0' : data[i].Team2FinalScore) + ")";
                        var period = data[i].PeriodDescription.trim();
                        var schedule = $.format.date(data[i].AcceptedDateTime.toString(), "E M/d hh:mm a") + " - (" + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT + ")";
                        var wagerType = (data[i].WagerType === "C" || data[i].WagerType === "A" ? "" : _self.getTypeInfo({item: data[i], birdCage: data[i].ARBirdcageLink, wagerType: data[i].WagerType, roundRobin: data[i].RoundRobinLink, ARLink: data[i].ARLink, totalPicks: data[i].totalPicks}));
                        var selection = rotationNumber + " " + period + " " + wagerType;
                        var singleWagerType = "SMLEA"; // Contiene las siglas de las apuestas simples.
                        var subElement = "";
                        var statusGame = _self.getWagerStatus({WagerStatus: data[i].Outcome});

                        var notLogo = '';


                        if (data[i].TotalPointsOU !== null) {

                            notLogo = 'not-logo';

                        }


                        if (description.toString().indexOf('/') != -1) {

                            notLogo = 'not-logo';

                        }




                        // Si es straigh bet solo formar encabezado
                        if (singleWagerType.includes(data[i].WagerType)) {

                            var periodDescription = '';

                            if (data[i].PeriodNumber > 0) {
                                periodDescription = ' - <span class="period-description-s">' + Util.periodAbrev[data[i].PeriodNumber];
                                +' </span> ';
                            }


                            if (data[i].WagerType === 'A') {
                                var tipo = data[i].Description;
                                subElement = HeaderContest.replace("{equipo}", tipo)
                                        .replace("{line-type}", 'prop-line-fix')
                                        .replace("{line}", '');
                            } else {

                                subElement = descriptionFormat.replace("@path", logo)
                                        .replace("{@choosenTeam}", description)
                                        .replace("{@not-logo}", notLogo)
                                        .replace("{line-type}", 'line-type' + data[i].WagerType)
                                        .replace("{@line}", line + periodDescription);

                            }

                        } else {

                            var lineT = data[i].FinalMoney;

                            if (data[i].FinalMoney > 0) {
                                lineT = '+' + data[i].FinalMoney;
                                ;
                            }

                            if (data[i].WagerType == 'C' || data[i].WagerType === 'A') {
                                var tipo = data[i].Team2ID.trim() + ' <strong>' + data[i].ChosenTeamID + '</strong>';
                                subElement = HeaderContest.replace("{equipo}", tipo + '<span class="prop-line-s">' + lineT + '</span>')
                                        .replace("{line-type}", 'prop-line-fix')
                                        .replace("{line}", '');

                                if (data[i].WagerType === 'A') {
                                    var tipo = data[i].Description;
                                    subElement = HeaderContest.replace("{equipo}", tipo)
                                            .replace("{line-type}", 'prop-line-fix')
                                            .replace("{line}", '');
                                }


                            } else {

                                if (data[i].WagerType === Util.BET.TYPE.TEASER.char) {

                                    if (data[i].TotalPointsOU !== null) {

                                        var totalPoints = 0;

                                        //------------------------------------------------------

                                        if (data[i].TotalPointsOU.toString().toLowerCase() == "o") {
                                            totalPoints =
                                                    parseFloat(data[i].AdjTotalPoints) -
                                                    parseFloat(data[i].TeaserPoints);
                                        } else {
                                            totalPoints =
                                                    parseFloat(data[i].AdjTotalPoints) +
                                                    parseFloat(data[i].TeaserPoints);
                                        }

                                        line = data[i].TotalPointsOU.toString() + ' ' + totalPoints;

                                    } else {

                                        var spreadPoints;

                                        //------------------------------------------------------

                                        spreadPoints = parseFloat(data[i].AdjSpread) + parseFloat(data[i].TeaserPoints);

                                        //------------------------------------------------------

                                        line = Util.isDecimal({
                                            number: Util.setSymbol({str: spreadPoints})
                                        });


                                        var periodDescription = '';

                                        if (data[i].PeriodNumber > 0) {
                                            periodDescription = ' - <span class="period-description-s">' + Util.periodAbrev[data[i].PeriodNumber];
                                            +' </span> ';
                                        }

                                    }


                                }

                                if (data[i].WagerType === 'G') {


                                    description = data[i].Description;

                                }

                                var periodDescription = '';

                                if (data[i].PeriodNumber > 0) {
                                    periodDescription = ' - <span class="period-description-s">' + Util.periodAbrev[data[i].PeriodNumber];
                                    +' </span> ';
                                }

                                subElement = descriptionFormat.replace("@path", logo)
                                        .replace("{@choosenTeam}", description)
                                        .replace("{@not-logo}", notLogo)
                                        .replace("{line-type}", 'line-type' + data[i].WagerType)
                                        .replace("{@line}", line + periodDescription)
                                        .replace("{statusClass}", data[i].Outcome)
                                        .replace("{statusGame}", data[i].Outcome);

                            }

                        }
                        element += subElement;
                    }
                    return element;
                },
                //----------------------------------------------------------------------
                getResultTicketMobileDetails: function (data) {

                    var _customer = require("customer/customer");
                    var Customer = new _customer();
                    var singleWagerType = "SMLECA";
                    var element = "";
                    var _self = this;



                    if (data[0].WagerType == 'C' || data[0].WagerType == 'A') {

                        var principalFormat = "<div class='col-md-12 col-sm-12 col-xs-12 gameReport sass'>" +
                                "<label class='normalDescription'>{tipo}</label>  " +
                                "<label>{equipo}</label>" +
                                "<label class='line'>{line}</label>";

                        if (data[0].WagerType == 'A') {
                            var principalFormat = "<div class='col-md-12 col-sm-12 col-xs-12 gameReport sass'>" +
                                    "<label class='normalDescription'>{tipo}</label>  " +
                                    "<label>{equipo}</label>";
                        }


                    } else {
                        var principalFormat = "<div class='col-md-12 col-sm-12 col-xs-12 wagerPendingMobileDetails'>" +
                                "<label class='normalDescription'>{RotationNumber}</label>" +
                                "<label style='margin-bottom:0px' class='normalDescription'> {chosenTeamId} </label>" +
                                "<label class='line'>{line}</label>";
                        ;
                    }


                    var headerFormat = "<div class='col-md-12 col-sm-12 col-xs-12 wagerPendingMobile j9'>" +
                            "<div class='col-md-3 col-sm-3 col-xs-3'>" +
                            "<label class='normalDescription'>{Header}</label>" +
                            "</div>" +
                            "<div class='col-md-9 col-sm-9 col-xs-9'>" +
                            "<label class='normalDescription'>{Content}</label>" +
                            "</div>" +
                            "</div>";

                    var footerFormat = "</div></br>";

                    for (var i = 0; i < data.length; i++) {

                        var item = data[i];


                        var wagerDescriptionFormat = "<div class='col-md-12 col-sm-12 col-xs-12 wagerPendingMobile j10'>" +
                                "<div class='col-md-4 col-sm-4 col-xs-4'>" +
                                "<label class=normalDescription>{Header}</label>" +
                                "</div>" +
                                "<div class='col-md-8 col-sm-8 col-xs-8 BOLA-10'>" +
                                "<label class=normalDescription>{Content}</label>" +
                                "</div>" +
                                "</div>";

                        var choosenTeamId = data[i].ChosenTeamID;
                        var rotationNumber = _self.getRotationNumber({Team1ID: data[i].Team1ID, ChosenTeamID: data[i].ChosenTeamID, Team1RotNum: data[i].Team1RotNum, Team2RotNum: data[i].Team2RotNum});
                        var line = _self.getLineGame({
                            TeaserPoints: data[i].TeaserPoints,
                            WagerType: data[i].LegWagerType, AdjSpread: data[i].AdjSpread, FinalMoney: data[i].FinalMoney, TotalPointsOU: data[i].TotalPointsOU, AdjTotalPoints: data[i].AdjTotalPoints, Description: data[i].Description, SportType: data[i].SportType, ChosenTeamID: data[i].ChosenTeamID, Team1ID: data[i].Team1ID, Team2ID: data[i].Team2ID});
                        var statusDesc = _self.getWagerStatus({WagerStatus: data[i].Outcome}) + "  (" + data[i].Team1ID + " " + ((data[i].Team1FinalScore == null) ? '0' : data[i].Team1FinalScore) + " - " + data[i].Team2ID + " " + ((data[i].Team2FinalScore == null) ? '0' : data[i].Team2FinalScore) + ")";
                        var period = data[i].PeriodDescription.trim();
                        var game = data[i].Team1ID.trim() + "/" + data[i].Team2ID.trim();
                        var schedule = $.format.date(data[i].GameDateTime.toString(), "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT;
                        var wagerType = _self.getTypeInfo({item: data[i], birdCage: data[i].ARBirdcageLink, wagerType: data[i].LegWagerType, roundRobin: data[i].RoundRobinLink, ARLink: data[i].ARLink, totalPicks: data[i].totalPicks});

                        var pitcher = '';

                        switch (item.SportType.toString().toUpperCase().trim()) {

                            case Util.SPORT.BASEBALL:

                                if (item.ListedPitcher1 !== null) {

                                    pitcher = '<br><div class="pitcher-pending">( ' +
                                            item.ListedPitcher1 + ' ' + Util.pitcherAction({type: item.Pitcher1ReqFlag}) + ' / ' +
                                            item.ListedPitcher2 + ' ' + Util.pitcherAction({type: item.Pitcher2ReqFlag}) + ' )</div>';
                                }

                                break;
                        }


                        if (data[i].WagerType === 'C') {
                            line = data[i].FinalMoney > 0 ? '+' + data[i].FinalMoney : data[i].FinalMoney;
                        }



                        var selection = data[i].SportSubType + ' - ' + ((data[i].LegWagerType === 'L') ? data[i].Team1RotNum + ' / ' + data[i].Team2RotNum : rotationNumber) + " " + period + " " + wagerType + pitcher;
                        var subElement = "";

                        var commentH = '';

                        if (item.Comments !== null && item.Comments !== '') {
                            commentH = wagerDescriptionFormat.replace("{Header}", ("Game Note :")).replace("{Content}", item.Comments);
                        }




                        // Si es straigh bet solo formar encabezado o Contest
                        if (singleWagerType.includes(data[i].WagerType)) {


                            if (data[i].WagerType === 'C' || data[i].WagerType === 'A') {



                                subElement += wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-38"}) + "#:")).replace("{Content}", "<b>" + item.TicketNumber + "</b>") +
                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-423"}) + ":")).replace("{Content}", _self.getWagerStatus({WagerStatus: item.WagerStatus})) +
                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-244"}) + "/" + Language.get({key: "L-393"}) + ":")).replace("{Content}", "<b>" + Util.currency[Customer.accountInfo.CurrencyCode] + Util.formatCurrency({val: item.AmountWagered / 100}) + "/" + Util.currency[Customer.accountInfo.CurrencyCode] + Util.formatCurrency({val: item.ToWinAmount / 100})) + "</b>" +
                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-237"}) + ":")).replace("{Content}", (data[i].WagerType === 'A' ? 'Manual Play' : game)) +
                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-206"}) + ":")).replace("{Content}", $.format.date(item.AcceptedDateTime.split(".")[0], "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT) +
                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-426"}) + ":")).replace("{Content}", schedule) +
                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-425"}) + ":")).replace("{Content}", item.PlacedOn) +
                                        commentH;// ((item.Comments !== '') ? wagerDescriptionFormat.replace("{Header}", ("Game Note :")).replace("{Content}", item.Comments) : '');

                            } else {

                                subElement += wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-38"}) + "#:")).replace("{Content}", "<b>" + item.TicketNumber + "</b>") +
                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-423"}) + ":")).replace("{Content}", _self.getWagerStatus({WagerStatus: item.WagerStatus})) +
                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-244"}) + "/" + Language.get({key: "L-393"}) + ":")).replace("{Content}", "<b>" + Util.currency[Customer.accountInfo.CurrencyCode] + Util.formatCurrency({val: item.AmountWagered / 100}) + "/" + Util.currency[Customer.accountInfo.CurrencyCode] + Util.formatCurrency({val: item.ToWinAmount / 100})) + "</b>" +
                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-237"}) + ":")).replace("{Content}", game) +
                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-424"}) + ":")).replace("{Content}", selection) +
                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-426"}) + ":")).replace("{Content}", schedule) +
                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-206"}) + ":")).replace("{Content}", $.format.date(item.AcceptedDateTime.split(".")[0], "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT) +
                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-425"}) + ":")).replace("{Content}", item.PlacedOn) +
                                        commentH;// ((item.Comments !== '') ? wagerDescriptionFormat.replace("{Header}", ("Game Note :")).replace("{Content}", item.Comments) : '');

                            }



                        } else {

                            if (data[i].TotalPointsOU !== null) {

                                choosenTeamId = data[i].ShortName1.trim() + ' / ' + data[i].ShortName2.trim();
                                rotationNumber = '';

                                selection = data[i].ShortName1.trim() + ' / ' + data[i].ShortName2.trim() + " " + period + " " + wagerType;


                            }

                            if (data[i].WagerType === Util.BET.TYPE.TEASER.char) {

                                if (data[i].TotalPointsOU !== null) {

                                    var totalPoints = 0;

                                    //------------------------------------------------------

                                    if (data[i].TotalPointsOU.toString().toLowerCase() == "o") {
                                        totalPoints =
                                                parseFloat(data[i].AdjTotalPoints) -
                                                parseFloat(data[i].TeaserPoints);
                                    } else {
                                        totalPoints =
                                                parseFloat(data[i].AdjTotalPoints) +
                                                parseFloat(data[i].TeaserPoints);
                                    }

                                    line = data[i].TotalPointsOU.toString() + ' ' + totalPoints;
                                    ;

                                } else {

                                    var spreadPoints;

                                    //------------------------------------------------------

                                    spreadPoints = parseFloat(data[i].AdjSpread) + parseFloat(data[i].TeaserPoints);

                                    //------------------------------------------------------

                                    line = Util.isDecimal({
                                        number: Util.setSymbol({str: spreadPoints})
                                    });


                                    var periodDescription = '';

                                    if (data[i].PeriodNumber > 0) {
                                        periodDescription = ' - <span class="period-description-s">' + Util.periodAbrev[data[i].PeriodNumber];
                                        +' </span> ';
                                    }

                                }


                            }



                            if (data[i].WagerType === 'G') {


                                subElement = principalFormat.replace("{RotationNumber}", rotationNumber + " ")
                                        .replace("{chosenTeamId}", data[i].Description)
                                        .replace("{line}", " " + line)
                                        .replace("{statusClass}", data[i].WagerStatus) +
                                        headerFormat.replace("{Header}", (Language.get({key: "L-423"}) + ":")).replace("{Content}", statusDesc) +
                                        headerFormat.replace("{Header}", (Language.get({key: "L-237"}) + ":")).replace("{Content}", '') +
                                        headerFormat.replace("{Header}", (Language.get({key: "L-424"}) + ":")).replace("{Content}", '') +
                                        headerFormat.replace("{Header}", (Language.get({key: "L-426"}) + ":")).replace("{Content}", '') +
                                        footerFormat;

                            } else {

                                var commentH = '';

                                if (data[i].Comments !== null && data[i].Comments !== '') {
                                    commentH = headerFormat.replace("{Header}", ("Game Note :")).replace("{Content}", data[i].Comments);
                                }

                                subElement = principalFormat.replace("{RotationNumber}", rotationNumber + " ")
                                        .replace("{chosenTeamId}", choosenTeamId)
                                        .replace("{line}", " " + line)
                                        .replace("{statusClass}", data[i].WagerStatus) +
                                        headerFormat.replace("{Header}", (Language.get({key: "L-423"}) + ":")).replace("{Content}", statusDesc) +
                                        headerFormat.replace("{Header}", (Language.get({key: "L-237"}) + ":")).replace("{Content}", game) +
                                        headerFormat.replace("{Header}", (Language.get({key: "L-424"}) + ":")).replace("{Content}", selection) +
                                        headerFormat.replace("{Header}", (Language.get({key: "L-426"}) + ":")).replace("{Content}", schedule) +
                                        commentH +
                                        footerFormat;


                            }

                        }


                        element += subElement;
                    }

                    return element;
                },
                //----------------------------------------------------------------------
                getResultMobileTicket: function (data) {
                    var element = "";
                    var _customer = require("customer/customer");
                    var Customer = new _customer();
                    var _self = this;
                    var wonTotal = 0;
                    var lossTotal = 0;


                    for (var i = 0; i < data.length; i++) {
                        //Calculate the status of the wager
                        var rotationNumber = _self.getRotationNumber({
                            Team1ID: data[i].Team1ID,
                            ChosenTeamID: data[i].ChosenTeamID,
                            Team1RotNum: data[i].Team1RotNum,
                            Team2RotNum: data[i].Team2RotNum
                        });

                        var choosenTeamId = data[i].ShortName1;



                        if (data[i].ChosenTeamID.trim() === data[i].Team2ID.trim()) {

                            choosenTeamId = data[i].ShortName2;

                        }



                        if (data[i].TotalPointsOU !== null && data[i].LegWagerType === 'L') {

                            choosenTeamId = data[i].ShortName1 + '/' + data[i].ShortName2;

                        }

                        var line = _self.getLineGame({
                            WagerType: data[i].LegWagerType,
                            AdjSpread: data[i].AdjSpread,
                            FinalMoney: data[i].FinalMoney,
                            TotalPointsOU: data[i].TotalPointsOU,
                            AdjTotalPoints: data[i].AdjTotalPoints,
                            Description: data[i].Description,
                            SportType: data[i].SportType,
                            ChosenTeamID: data[i].ChosenTeamID,
                            Team1ID: data[i].Team1ID,
                            Team2ID: data[i].Team2ID,
                            TeaserPoints: data[i].TeaserPoints
                        });


                        var statusDesc = "";
                        var period = "";
                        var schedule = "";
                        var wagerType = (data[i].LegWagerType === "C" ? "" : Util.getTypeInfo({birdCage: data[i].ARBirdcageLink, wagerType: data[i].WagerType, roundRobin: data[i].RoundRobinLink, ARLink: data[i].ARLink, totalPicks: data[i].totalPicks}));
                        var selection = "";
                        var TicketId = data[i].TicketNumber + "-" + data[i].WagerNumber;
                        var gameTeams = "";

                        wonTotal = parseFloat(data[i].AmountWon) / 100;
                        lossTotal = parseFloat(data[i].AmountLost) / 100;

                        var amountClass = Util.setBackground(wonTotal - lossTotal);
                        var amount = _self.getMathSing({Amount: (wonTotal - lossTotal)}) + Util.getCurrency(Customer.accountInfo.CurrencyCode) + " " + Util.formatCurrency({val: Math.abs((wonTotal - lossTotal)), decimal: true});

                        var singleWagerType = "SMLEA"; // Contiene las siglas de las apuestas simples.

                        var subElement = "";

                        switch (data[i].LegWagerType) {

                            case  'S' :
                                wagerType = ' Spread';
                                break;

                            case  'M' :
                                wagerType = ' Money Line';
                                break;

                            case  'L' :
                                wagerType = ' Total';
                                break;

                            case  'E' :
                                wagerType = ' Team Total';
                                break;

                        }

                        if (data[i].WagerStatus === 'X' &&
                                data[i].AmountWon === null
                                && data[i].AmountLost === null) {

                            amount = Util.getCurrency(Customer.accountInfo.CurrencyCode) + ' 0.00';
                            amountClass = 'label-info';

                        }

                        //----- WEEKLY MOBILE


                        // Si numero de rotacion es diferente de 0 es que tiene informacion para mostrar normalDescription

                        if (data[i].Team1RotNum != 0) {
                            statusDesc = _self.getWagerStatus({WagerStatus: data[i].Outcome}) + "   (" + data[i].Team1ID + " " + data[i].Team1FinalScore + " - " + data[i].Team2ID + " " + data[i].Team2FinalScore + ")";
                            period = ((data[i].PeriodDescription.trim() === "Game") ? "" : data[i].PeriodDescription.trim());
                            schedule = $.format.date(data[i].GameDateTime.toString(), "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT;
                            selection = data[i].SportSubType.trim() + " - " + ((data[i].LegWagerType === "L") ? data[i].Team1RotNum + " / " + data[i].Team2RotNum : rotationNumber) + " " + data[i].PeriodDescription.toString().trim() + " " + wagerType;
                            gameTeams = data[i].Team1ID + "/" + data[i].Team2ID;
                        }

                        var logo = _self.getLogonMobile({Team1ID: data[i].Team1ID, Team2ID: data[i].Team2ID, ChosenTeamID: data[i].ChosenTeamID, ShortName1: data[i].ShortName1,
                            ShortName2: data[i].ShortName2, LogoTeam1: data[i].LogoTeam1, LogoTeam2: data[i].LogoTeam2});
                        var description = _self.getDescriptionMobile({Team1ID: data[i].Team1ID, Team2ID: data[i].Team2ID, ChosenTeamID: data[i].ChosenTeamID,
                            ShortName1: data[i].ShortName1, ShortName2: data[i].ShortName2, info: data[i]});




                        var notLogo = '';


                        if (data[i].TotalPointsOU !== null) {

                            notLogo = 'not-logo';

                        }

                        if (description !== undefined) {

                            if (description.toString().indexOf('/') != -1) {

                                notLogo = 'not-logo';

                            }

                        }


                        var freeP = '';

                        if (data[i].FreePlayFlag == "Y") {
                            freeP = '<span class="label label-primary freeplaySpan fix-t-5">FP</span>';
                        }



                        // Si es straigh bet solo formar encabezado
                        if (singleWagerType.includes(data[i].WagerType) || data[i].WagerType === 'G') {
                            var contentFormat = "<div class='col-md-12 col-sm-12 col-xs-12 dvWagerHeaderP w-status-" + data[i].WagerStatus + "'>" +
                                    "<div class='col-md-8 col-sm-8 col-xs-8  BOLA-12 line-f-" + data[i].WagerType + "  '>" +
                                    "<img class='team-logo not-after {@not-logo}' src='@path'/>" +
                                    "<label>{chosenTeam}</label>" +
                                    "<label class='line'>{line}</label>" +
                                    "<label class='period'>{period}</label>" +
                                    freeP +
                                    "</div>" +
                                    "<div class='col-md-4 col-sm-4 col-xs-4'>" +
                                    "<span class='label {amountClass}'>{amount}</span>" +
                                    "</div>" +
                                    "</div>";

                            var periodDescription = '';

                            if (data[i].PeriodNumber > 0) {
                                periodDescription = ' - <span class="period-description-s">' + Util.periodAbrev[data[i].PeriodNumber];
                                +' </span> ';
                            }

                            var statusGeneral = _self.getWagerStatus({WagerStatus: data[i].Outcome});

                            if (data[i].WagerType === 'G' || data[i].WagerType === 'A') {
                                choosenTeamId = data[i].Description;
                                statusGeneral = '';
                            }



                            if (data[i].FreePlayFlag === "Y" && data[i].WagerStatus === 'L') {
                                amount = '-0.00';
                            }



                            subElement += contentFormat.replace("{chosenTeam}", choosenTeamId)
                                    .replace("{line}", line)
                                    .replace("{period}", periodDescription)
                                    .replace("{amountClass}", amountClass)
                                    .replace("@path", logo)
                                    .replace("{@not-logo}", notLogo)
                                    .replace("{amount}", amount);

                        } else {


                            if (data[i].WagerType === "C") {

                                //console.log('SNKE');

                                var tipo = data[i].Team2ID.trim();

                                var line = _self.getLineGame({
                                    WagerType: data[i].LegWagerType,
                                    AdjSpread: data[i].AdjSpread,
                                    FinalMoney: data[i].FinalMoney,
                                    TotalPointsOU: data[i].TotalPointsOU,
                                    AdjTotalPoints: data[i].AdjTotalPoints,
                                    Description: data[i].Description,
                                    SportType: data[i].SportType,
                                    ChosenTeamID: data[i].ChosenTeamID,
                                    Team1ID: data[i].Team1ID,
                                    Team2ID: data[i].Team2ID,
                                    TeaserPoints: data[i].TeaserPoints
                                });

                                //   console.log(data[i]);

                                contentFormat = "<div class='report-h-repeat c-type col-md-12 col-sm-12 col-xs-12 dvWagerHeaderP'>" +
                                        "<div class='col-md-9 col-sm-9 col-xs-9 dvContestHeader'>" +
                                        "<label class='normalDescription'>{tipo}</label>" +
                                        "<label>{equipo}</label>" +
                                        "<label>{line}</label>" +
                                        "</div>" +
                                        "<div class='col-md-3 col-sm-3 col-xs-3'><span class='label {amountClass}'>{amount}</span></div>" +
                                        "</div>";

                                if (data[i].FreePlayFlag === "Y" && data[i].WagerStatus === 'L') {
                                    amount = '-0.00';
                                }


                                subElement += contentFormat.replace("{tipo}", tipo)
                                        .replace("{equipo}", data[i].ChosenTeamID)
                                        .replace("{line}", line)
                                        .replace("{amountClass}", amountClass)
                                        .replace("{amount}", amount);
                            } else {


                                var gameDetailFormat = "<div class='col-md-12 col-sm-12 col-xs-12 dvWagerChosenTeamDetail'>" +
                                        "<div class='col-md-4 col-sm-4 col-xs-4'><label class='{headerClass}'>{header}</label></div>" +
                                        "<div class='col-md-8 col-sm-8 col-xs-8 bola-43'><label class='{contentClass}'>{content}</label></div>" +
                                        "</div>";

                                var headerFormat = "<div class='col-md-12 col-sm-12 col-xs-12 dvWagerHeader'>" +
                                        "<img class='team-logo not-after {@not-logo}' src='@path'/>" +
                                        "<label>{chosenTeam}</label>" +
                                        "<label class='line'>{line}</label>" +
                                        "<label data-status='{dataWagerStatus}'>{status}</label>" +
                                        "</div>";

                                var gamesFormat = "<div data-group='{@dataGroup}' class='col-md-12 col-sm-12 col-xs-12 dvWagerBody hidden'>" +
                                        "<div class='col-md-12 col-sm-12 col-xs-12 dvWagerChosenTeam'>" +
                                        "@contentGame" +
                                        "</div>" +
                                        "</div>";


                                if (data[i].WagerType === 'G') {


                                    if (data[i].WagerStatus === 'W') {
                                        statusDesc = 'Won';

                                    }


                                    if (data[i].WagerStatus === 'L') {
                                        statusDesc = 'Loss';
                                    }


                                }


                                var commentH = '';

                                if (data[i].Comments !== null && data[i].Comments !== '') {
                                    commentH = gameDetailFormat.replace("{headerClass}", "normalDescription")
                                            .replace("{header}", (Language.get({key: "L-427"}) + ":"))
                                            .replace("{contentClass}", "normalDescription").replace("{content}", data[i].Comments);
                                }

                                var pitcher = '';

                                switch (data[i].SportType.toString().toUpperCase().trim()) {

                                    case Util.SPORT.BASEBALL:

                                        if (data[i].ListedPitcher1 !== null) {

                                            pitcher = '<br><div class="pitcher-pending">( ' +
                                                    data[i].ListedPitcher1 + ' ' + Util.pitcherAction({type: data[i].Pitcher1ReqFlag}) + ' / ' +
                                                    data[i].ListedPitcher2 + ' ' + Util.pitcherAction({type: data[i].Pitcher2ReqFlag}) + ' )</div>';
                                        }

                                        break;
                                }




                                var game = gameDetailFormat.replace("{headerClass}", "normalDescription").replace("{header}", (Language.get({key: "L-423"}) + ":")).replace("{contentClass}", "normalDescription").replace("{content}", statusDesc) +
                                        gameDetailFormat.replace("{headerClass}", "normalDescription").replace("{header}", (Language.get({key: "L-237"}) + ":")).replace("{contentClass}", "normalDescription").replace("{content}", gameTeams) +
                                        gameDetailFormat.replace("{headerClass}", "normalDescription").replace("{header}", (Language.get({key: "L-424"}) + ":")).replace("{contentClass}", "normalDescription").replace("{content}", selection + pitcher) +
                                        gameDetailFormat.replace("{headerClass}", "normalDescription").replace("{header}", (Language.get({key: "L-426"}) + ":")).replace("{contentClass}", "normalDescription").replace("{content}", schedule) + commentH;

                                var bodyGame = gamesFormat.replace("@contentGame", game).replace("{@dataGroup}", TicketId);

                                var periodDescription = '';

                                if (data[i].PeriodNumber > 0) {
                                    periodDescription = ' - <span class="period-description-s">' + Util.periodAbrev[data[i].PeriodNumber];
                                    +' </span> ';
                                }

                                var statusGeneral = _self.getWagerStatus({WagerStatus: data[i].Outcome});

                                if (data[i].WagerType === 'G') {
                                    choosenTeamId = data[i].Description;
                                    statusGeneral = data[i].Outcome;

                                    if (data[i].WagerStatus === 'W') {
                                        statusGeneral = 'Won';

                                    }


                                    if (data[i].WagerStatus === 'L') {
                                        statusGeneral = 'Loss';
                                    }

                                }

                                ///----------------------------------------------


                                if (data[i].WagerType === Util.BET.TYPE.TEASER.char) {

                                    if (data[i].TotalPointsOU !== null &&
                                            data[i].LegWagerType === 'L') {

                                        var totalPoints = 0;

                                        //------------------------------------------------------

                                        if (data[i].TotalPointsOU.toString().toLowerCase() == "o") {
                                            totalPoints =
                                                    parseFloat(data[i].AdjTotalPoints) -
                                                    parseFloat(data[i].TeaserPoints);
                                        } else {
                                            totalPoints =
                                                    parseFloat(data[i].AdjTotalPoints) +
                                                    parseFloat(data[i].TeaserPoints);
                                        }

                                        line = data[i].TotalPointsOU.toString() + ' ' + totalPoints;

                                    } else {

                                        var spreadPoints;

                                        //------------------------------------------------------

                                        spreadPoints = parseFloat(data[i].AdjSpread) + parseFloat(data[i].TeaserPoints);

                                        //------------------------------------------------------

                                        line = Util.isDecimal({
                                            number: Util.setSymbol({str: spreadPoints})
                                        });

                                    }
                                }


                                var headerWager = headerFormat.replace("{chosenTeam}", choosenTeamId)
                                        .replace("{line}", line + periodDescription)
                                        .replace("{dataWagerStatus}", data[i].Outcome)
                                        .replace("@path", logo)
                                        .replace("{@not-logo}", notLogo)
                                        .replace("{status}", _self.getWagerStatus({WagerStatus: data[i].Outcome}));

                                subElement += headerWager + bodyGame;
                            }
                        }

                        element += subElement;


                    }
                    return element;
                },
                //----------------------------------------------------------------------
                getTicketDetail: function (options) {
                    var defaults = {
                        trigger: false,
                        operation: "getTicketDetailPrint",
                        token: Security.token,
                        external: false
                    };

                    //------------------------------------------------------------------

                    var setting = $.extend(defaults, options);
                    var _self = {};
                    var ticketNumber = 0;
                    var wagerNumber = 0;
                    var flag = "";

                    //------------------------------------------------------------------

                    if (setting.trigger) {
                        _self = this;

                        //--------------------------------------------------------------

                        ticketNumber = options.ticketNumber;
                        wagerNumber = options.wagerNumber;
                        flag = options.flag;
                    } else {
                        _self = options.info.self;

                        //--------------------------------------------------------------

                        ticketNumber = options.info.ticketNumber;
                        wagerNumber = options.info.wagerNumber;
                        flag = options.info.flag;
                    }

                    //------------------------------------------------------------------

                    var param = {
                        token: setting.token,
                        ticketNumber: ticketNumber,
                        wagerNumber: wagerNumber,
                        flag: flag,
                        operation: setting.operation
                    };

                    //------------------------------------------------------------------

                    $.ajax({
                        url: _self.path + param.operation,
                        cache: false,
                        data: param,
                        type: "POST",
                        beforeSend: function () {
                            UI.setLoad({
                                el: $("body"),
                                class: "big-load"
                            });
                        },
                        success: function (data) {
                            if (setting.trigger) {
                                options.data = data;
                                options.self = _self;
                                options.external = setting.external;

                                setting.func(options);
                            } else {
                                var modal = options.component;

                                $('[data-modal="ticket-detail"]').remove();

                                modal.find("[data-modal]").attr("data-modal", "ticket-detail");
                                modal.find('[data-field="title"]').html("Ticket Detail (" + "<span>" + options.info.ticketNumber + "-" + options.info.wagerNumber + "</span> )");
                                modal.find(".modal-body").html(_self.detailTicket({data: data, wagerType: options.info.flag, description: options.info.description}));

                                $("body").append(modal.html());
                                $('[data-modal="ticket-detail"]').modal("show");
                                UI.removeElement({el: $('body [data-control="load"]'), time: 1});
                            }
                        }
                    });
                },
                //----------------------------------------------------------------------
                setTicketDetail: function (options) {
                    var defaults = {
                        self: this,
                        description: ""
                    };

                    //------------------------------------------------------------------

                    var setting = $.extend(defaults, options);

                    //------------------------------------------------------------------

                    var _self = setting.self;

                    //------------------------------------------------------------------

                    UI.getComponent({
                        component: "modal",
                        func: _self.getTicketDetail,
                        info: {
                            ticketNumber: options.ticketNumber,
                            wagerNumber: options.wagerNumber,
                            description: setting.description,
                            flag: options.flag,
                            self: _self
                        }
                    });
                },
                //----------------------------------------------------------------------
                listeners: function () {
                    var content = $('[data-content="report"]');
                    var contentList = $('[data-list="wagers"]');
                    var _self = this;
                    var _customer = require("customer/customer");
                    var Customer = new _customer();
                    var _line = require("customer/line/line");
                    var Line = new _line();
                    var _league = require("customer/line/league");
                    var League = new _league();
                    var _limit = require("customer/limit/limit");
                    var Limit = new _limit();
                    var _parlay = require("customer/wager/parlay");
                    var Parlay = new _parlay();
                    var _teaser = require("customer/wager/teaser");
                    var Teaser = new _teaser();

                    function _openSpotsGet(el) {

                        $('[data-page="line"] [data-content="lines"]').empty();
                        $('.modal#confirm-wager').remove();
                        $('.modal#set-wager').remove();

                        $('[data-panel="center"] .tools').removeClass('hidden');

                        //------------------------------------------------------

                        switch (el.data("type")) {
                            case Util.BET.TYPE.PARLAY.char:
                                if (UI.modeSelected == UI.mode.BET_SLIP) {
                                    Util.__proto__.BET.SELECTED = Util.BET.TYPE.STRAIGHT.val;
                                    League.getSportsLeagues({customerID: Customer.ID});
                                    Line.getUpcomingLines({hour: Util.upcoming.first, customerID: Customer.ID});

                                    //--------------------------------------------------

                                    $('[data-panel="right"] [data-wager="' + Util.BET.TYPE.PARLAY.val + '"]').trigger("click");
                                } else {
                                    //------------------------------------------------------

                                    $("#select-wager select").val(Util.BET.TYPE.PARLAY.val);

                                    if (!Util.isMobile()) {

                                        $("#select-wager select").selectpicker("render");

                                        Limit.parlay.getSpecs();
                                        Util.__proto__.BET.SELECTED = Util.BET.TYPE.PARLAY.val;
                                        League.getSportsLeagues({customerID: Customer.ID});
                                        Line.getUpcomingLines({hour: Util.upcoming.first, customerID: Customer.ID});

                                    } else {

                                        var panelLeft = $('[data-slide="Left"][data-panel="left"]');


                                        panelLeft.removeClass('slideOutLeft');
                                        $('[data-page="reports"] [data-content="report"]').empty();


                                        //-----------------------------------

                                        Limit.parlay.getSpecs();
                                        Util.__proto__.BET.SELECTED = Util.BET.TYPE.PARLAY.val;
                                        League.getSportsLeagues({customerID: Customer.ID});



                                    }



                                    //------------------------------------------------------


                                }

                                //------------------------------------------------------

                                Parlay.loadOldOpenInfo(el.data("param"));

                                break;

                                //------------------------------------------------------

                            case Util.BET.TYPE.TEASER.char:
                                if (UI.modeSelected == UI.mode.BET_SLIP) {
                                    Util.__proto__.BET.SELECTED = Util.BET.TYPE.STRAIGHT.val;
                                    League.getSportsLeagues({customerID: Customer.ID});
                                    Line.getUpcomingLines({hour: Util.upcoming.first, customerID: Customer.ID});

                                    Teaser.__proto__.points = {};
                                    Teaser.__proto__.adjustPoints = 0;

                                    //--------------------------------------------------

                                    $('[data-panel="right"] [data-wager="' + Util.BET.TYPE.TEASER.val + '"]').trigger("click");

                                } else {
                                    $("#select-wager select").val(Util.BET.TYPE.TEASER.val);
                                    if (!Util.isMobile()) {

                                        $("#select-wager select").selectpicker("render");

                                    }

                                    $('[data-panel="center"] .tools').removeClass('hidden');

                                    //--------------------------------------------------

                                    Util.__proto__.BET.SELECTED = Util.BET.TYPE.TEASER.val;
                                    // Teaser.load();

                                    //------------------------------------------------------
                                }

                                Teaser.loadOldOpenInfo($.parseJSON(el.attr("data-param")));

                                break;
                        }
                        $('[data-panel="center"]').removeClass().addClass('col-lg-10 col-md-9 col-sm-8 col-xs-12');
                        $('[data-panel="left"],.tools').show();

                        return false;
                    }

                    content.find('[data-action="buyout-parlay"]').off('click').on('click', function (e) {

                        _self.getUIBuyOut({
                            data: $(this).attr('data-param'),
                            el: $(this)
                        });

                        e.preventDefault();
                        e.stopPropagation();

                    });

                    //------------------------------------------------------------------
                    contentList.find('[data-action="open-spots"]').off('click').on("click", function (e) {

                        _openSpotsGet($(this));

                        e.stopPropagation();
                        e.preventDefault();

                    });

                    //----------------------------------------------------------
                    content.find('[data-action="open-spots"]').off('click').on("click", function (e) {

                        _openSpotsGet($(this));

                        e.stopPropagation();
                        e.preventDefault();

                    });
                    //------------------------------------------------------------------
                    content.find('[data-action="show-ticket-detail"]').on("click", function () {

                        var ticket = this.getAttribute("data-ticket");
                        $("div[data-group='" + this.getAttribute("data-ticket") + "']").toggleClass("hidden");
                    });
                    contentList.find('[data-action="show-ticket-detail"]').off().on("click", function () {

                        var ticket = this.getAttribute("data-ticket");
                        $("div[data-group='" + this.getAttribute("data-ticket") + "']").toggleClass("hidden");
                    });

                    $("[data-list='wagerTypeSelector']").change(function (evt) {
                        var seleted = Util.isMobile() ? $("#wagerTypeMobile").val() : $("#wagerTypeWeb").val();

                        $("#reportsTypes").children("div").each(function () {
                            $(this).attr("id") === seleted ? $(this).show() : $(this).hide();
                        });
                    });

                    $("tr.header").click(function () {
                        $("div[data-group='" + this.getAttribute("data-ticket") + "']").toggleClass("hidden");
                    });

                    $("div.dvWagerContent").click(function () {
                        $("div[data-group='" + this.getAttribute("data-ticket") + "']").toggleClass("hidden");
                    });




                },
                //----------------------------------------------------------------------
                statePitcher: function (options) {
                    var state = "";

                    //------------------------------------------------------------------

                    switch (options.flag) {
                        case "Y":
                            state = "Must Pitch";
                            break;

                            //----------------------------------------------------------

                        case "N":
                            state = "Action";
                            break;
                    }

                    //------------------------------------------------------------------

                    return state;
                },
                //----------------------------------------------------------------------
                callPrinterTicket: function (options) {
                    UI.getComponent({
                        component: options.self.componentPath + "print-ticket",
                        func: options.self.writeTicket,
                        info: {
                            self: options.self,
                            get: options
                        }
                    });
                },
                //----------------------------------------------------------------------
                writeTicket: function (options) {
                    //------------------------------------------------------------------
                    var _self = options.info.self;
                    var modal = options.component;
                    var info = options.info;
                    var date = moment(Date()).format("DD/MM/YYYY - hh:mm a");
                    var risk = info.get.data.INFO.AmountWagered / 100;
                    var win = info.get.data.INFO.ToWinAmount / 100;
                    var item = "";
                    var customer = "";
                    var currencyCode = "";

                    //------------------------------------------------------------------

                    if (options.info.get.external) {
                        customer = options.info.get.customerID;
                        currencyCode = options.info.get.currencyCode;
                    } else {
                        var _customer = require("customer/customer");
                        var Customer = new _customer();

                        customer = Customer.ID;

                        //--------------------------------------------------------------

                        currencyCode = Util.getCurrency(Customer.accountInfo.CurrencyCode);
                    }

                    //----------------------------------------------------------

                    var type = '';

                    switch (options.info.get.flag) {
                        case  Util.BET.TYPE.STRAIGHT.char  :
                        case  'C'  :
                            type = Util.BET.TYPE.STRAIGHT.val;
                            break;
                        case  Util.BET.TYPE.PARLAY.char  :
                            type = Util.BET.TYPE.PARLAY.val;
                            break;
                        case  Util.BET.TYPE.IF_BET.char  :
                            type = Util.BET.TYPE.IF_BET.val;
                            break;
                        case  Util.BET.TYPE.TEASER.char  :
                            type = Util.BET.TYPE.TEASER.val;
                            break;
                        case  Util.BET.TYPE.REVERSE.char  :
                            type = Util.BET.TYPE.REVERSE.val;
                            break;
                    }

                    //----------------------------------------------------------

                    modal.find('[data-field="type"]').html(type);
                    modal.find('[data-field="customer"]').html(customer);
                    modal.find('[data-field="site-title"]').html(window.location.host);
                    modal.find('[data-field="ticket-number"]').html(info.get.ticketNumber);
                    modal.find('[data-field="date"]').html(date);


                    if (Util.BET.TYPE.STRAIGHT.char !== options.info.get.flag &&
                            'C' !== options.info.get.flag &&
                            Util.BET.TYPE.REVERSE.char !== options.info.get.flag) {
                        modal.find('[data-field="risk"]').html(currencyCode + " " + risk);
                        modal.find('[data-field="win"]').html(currencyCode + " " + win);
                    } else {

                        modal.find('[data-field="risk"]').remove();
                        modal.find('[data-field="win"]').remove();
                        modal.find('.risk-title').remove();
                        modal.find('.win-title').remove();
                    }

                    //------------------------------------------------------------------
                    var code = Util.currency[Customer.accountInfo.CurrencyCode];

                    for (var i = 0; i < info.get.data.LIST.length; i++) {

                        var itemInfo = info.get.data.LIST[i];

                        if (Util.BET.TYPE.STRAIGHT.char !== options.info.get.flag &&
                                'C' !== options.info.get.flag &&
                                Util.BET.TYPE.REVERSE.char !== options.info.get.flag) {
                            item += '<li class="list-group-item" data-field="rules">' + _self.detailItemPrintTicket({item: itemInfo, wagerType: options.wagerType}) + "</li>";

                        } else {
                            item += '<li class="list-group-item" data-field="rules"><div>'
                                    + _self.detailItemPrintTicket({item: itemInfo, wagerType: options.wagerType}) +
                                    '</div>' +
                                    '<div>' +
                                    '<span style="margin-right :2px;" data-language="L-70"></span> <span style="color:red;margin-right :2px;">'
                                    + code +
                                    Util.formatCurrency({val: itemInfo.AmountWagered / 100, decimal: true}) + '</span>' +
                                    '<span style="margin-right :2px;" data-language="L-71"></span> <span style="color:green;margin-right :2px;">'
                                    + code +
                                    Util.formatCurrency({val: itemInfo.ToWinAmount / 100, decimal: true}) + '</span>' +
                                    '</div>' +
                                    '</li>';
                        }


                    }

                    //------------------------------------------------------------------

                    $(item).insertBefore(modal.find('[data-field="rules"]'));

                    //------------------------------------------------------------------

                    $('[data-modal="print-ticket"]').remove();
                    $("body").append(modal.html());

                    //------------------------------------------------------------------

                    $('[data-action="print"]').on("click", function () {
                        $('[data-modal="print-ticket"] .modal-body').printThis({
                            importCSS: true,
                            loadCSS: "css/print.css?v=" + new Date().getTime()
                        });
                    });

                    //------------------------------------------------------------------

                    $('[data-modal="print-ticket"]').modal("show");
                    UI.removeElement({
                        el: $('body [data-control="load"]'),
                        time: 0
                    });
                },
                //----------------------------------------------------------------------
                detailItemPrintTicket: function (options) {
                    var item = options.item;
                    var bet = "";
                    var line = "";

                    //------------------------------------------------------------------

                    switch (item.WagerType) {
                        case Util.BET.SUB_TYPE.MONEY.val:
                            break;

                            //--------------------------------------------------

                        case Util.BET.SUB_TYPE.TOTAL.val:
                            line = (item.TotalPointsOU.toString().toLowerCase() == "o" ? "Over" : "Under") + " " + Util.isDecimal({number: item.AdjTotalPoints});

                            if (options.wagerType == Util.BET.TYPE.TEASER.char) {
                                var totalPoints = 0;

                                //------------------------------------------------------

                                if (item.TotalPointsOU.toString().toLowerCase() == "o") {
                                    totalPoints =
                                            parseFloat(item.AdjTotalPoints) - parseFloat(item.TeaserPoints);
                                } else {
                                    totalPoints =
                                            parseFloat(item.AdjTotalPoints) + parseFloat(item.TeaserPoints);
                                }

                                //------------------------------------------------------

                                line =
                                        (item.TotalPointsOU.toString().toLowerCase() == "o" ?
                                                "Over" :
                                                "Under") +
                                        " " +
                                        Util.isDecimal({
                                            number: totalPoints
                                        });
                            }

                            break;

                            //--------------------------------------------------

                        case Util.BET.SUB_TYPE.TEAM_TOTAL.val:
                            line = "Team Total " + (item.TotalPointsOU == "o" ? "Over" : "Under") + " " + Util.isDecimal({number: item.AdjTotalPoints});
                            break;

                            //--------------------------------------------------

                        case Util.BET.SUB_TYPE.SPREAD.val:
                            line = Util.isDecimal({number: item.AdjSpread});
                            line = Util.setSymbol({str: line});

                            //----------------------------------------------------------

                            if (options.wagerType == Util.BET.TYPE.TEASER.char) {
                                var spreadPoints;

                                //------------------------------------------------------

                                spreadPoints = parseFloat(item.AdjSpread) + parseFloat(item.TeaserPoints);

                                //------------------------------------------------------

                                line = Util.isDecimal({number: Util.setSymbol({str: spreadPoints})});
                            }

                            break;
                    }

                    //------------------------------------------------------------------

                    var gameDate = $.format.date(item.GameDateTime, "E M/d hh:mm a");

                    //------------------------------------------------------------------

                    var finalMoney = 0;

                    //---------------------------------------------------------

                    switch (Util.oddSelected) {

                        case Util.odds.AMERICAN:

                            finalMoney = Util.setSymbol({
                                str: item.FinalMoney
                            });


                            break;

                            //----------------------------------------------------------

                        case Util.odds.DECIMAL:

                            finalMoney = item.FinalDecimal;
                            break;

                            //----------------------------------------------------------

                        case Util.odds.FRACTIONAL:
                            finalMoney = item.FinalNumerator + ' ' + item.FinalDenominator;
                            break;
                    }

                    //------------------------------------------------------------------

                    if (options.wagerType == Util.BET.TYPE.TEASER.char) {
                        finalMoney = "";
                    }

                    //------------------------------------------------------------------

                    var chosenTeam = item.ChosenTeamID + " | ";

                    if (item.WagerType == Util.BET.SUB_TYPE.MONEY.val && item.DoubleChance != "Y" && item.ScoreOrNot != "Y") {
                        if (item.ChosenTeamID.toString().indexOf("/") > -1) {
                            chosenTeam =
                                    Language.get({
                                        key: "L-141"
                                    }) +
                                    " | " +
                                    item.ChosenTeamID +
                                    " | ";
                        }
                    }

                    //----------------------------------------------------------------
                    var sportType = '';
                    var sportSubType = '';
                    if (item.SportType == undefined) {
                        sportType = item.ContestDesc;
                        sportSubType = item.ContestType3;
                    } else {

                        sportType = item.SportType.toString()
                                .split(" ")
                                .join("")
                                .toUpperCase()
                                .trim();

                        sportSubType = item.SportSubType;

                        if (sportType.toUpperCase() == Util.SPORT.SOCCER) {
                            sportSubType = "FUTBOL ";
                        }


                    }

                    //----------------------------------------------------------

                    var periodDescription = '';
                    if (item.PeriodDescription == undefined) {
                        periodDescription = '';
                        chosenTeam = item.ContestantName;
                        gameDate = moment(item.ContestDateTime).format('LLL');
                    } else {
                        periodDescription = item.PeriodDescription.trim();
                    }
                    //------------------------------------------------------------------

                    bet = "<div>" + chosenTeam + line + " " + finalMoney + "</div>" + "<div><span>" + sportSubType + '</span><i class="icon-' + sportType.toLowerCase() + '"></i> ' + periodDescription + " | <span>" + gameDate + "</span></div>";

                    //------------------------------------------------------------------

                    return bet;
                },
                ///---------------------------------------------------------------------
                getLeaderBoard: function (options) {
                    var defaults = {
                        agentID: "KSCMA"
                    };
                    //------------------------------------------------------------------

                    var setting = $.extend(defaults, options);

                    var _self = this;
                    var _customer = require("customer/customer");
                    var Customer = new _customer();

                    var param = {
                        agentID: setting.agentID,
                        token: Security.token,
                        operation: "getLeaderBoard"
                    };

                    //------------------------------------------------------------------

                    $.ajax({
                        url: this.path + param.operation,
                        cache: false,
                        data: param,
                        type: "POST",
                        beforeSend: function () {
                            UI.setLoad({
                                el: $("[data-page]"),
                                class: "big-load"
                            });
                        },
                        success: function (data) {
                            UI.getComponent({
                                component: "/modal",
                                func: _self.setLeaderBoard,
                                info: {
                                    self: _self
                                },
                                data: data
                            });
                        }
                    });
                },
                //----------------------------------------------------------------------
                setLeaderBoard: function (options) {
                    var _self = options.info.self;
                    var modal = options.component;
                    var el = "";

                    //-----------------------------------------------------------

                    $('[data-modal="leader-board-modal"]').remove();
                    modal.find("[data-modal]").attr("data-modal", "leader-board-modal");
                    modal.find('[data-field="title"]').html(Language.get({
                        key: "L-256"
                    }));

                    //--------------------------------------------------------------------

                    for (var i = 0; i < options.data.LIST.length; i++) {
                        var item = options.data.LIST[i];
                        el +=
                                ' <li class="list-group-item"> ' +
                                '<span class="badge">' + Util.formatCurrency({val: item.Balance}) +
                                "</span> " + item.customerID +
                                "</li> ";
                    }

                    //----------------------------------------------------------------------

                    modal.find(".modal-body").html('<ul class="list-group">' + el + "</ul>");

                    $("body").append(modal.html());
                    $('[data-modal="leader-board-modal"]').modal("show");

                    UI.removeElement({el: $('[data-page] [data-control="load"]'), time: 1});
                },
                //--------------------------------------------------------------------------
                getPendingByTicket: function (options) {

                    var _self = this;
                    var _customer = require('customer/customer');
                    var Customer = new _customer();
                    //------------------------------------------------------------------

                    var param = {
                        customerID: Customer.ID,
                        ticketNumber: options.ticketNumber,
                        token: Security.token,
                        operation: 'getPendingByTicket'

                    };
                    //------------------------------------------------------------------

                    var parent = '';
                    var el = "";
                    //------------------------------------------------------------------

                    if (Util.isMobile()) {
                        el = '<div class="row" data-header="headerDetails">' +
                                '<div class="col-xs-8 headerDetailsDescription"><label>' + Language.get({key: "L-207"}) + "<label></div>" +
                                '<div class="col-xs-2 headerDetailsAmounts"><label>' + Language.get({key: "L-244"}) + "</label></div>" +
                                '<div class="col-xs-2 headerDetailsAmounts"><label>' + Language.get({key: "L-245"}) + "</label></div>" +
                                "</div>";
                    } else {
                        el = ' <div class="accordion-inner table-responsive" > ' +
                                '               <table class="table table-striped table-bordered table-hover"' +
                                '                      cellspacing="0" width="100%" data-table="0">' +
                                '                    <thead data-content="head">' +
                                "                        <tr>" +
                                '                            <th style="width:15%; text-align:center;" data-language="L-206">' + Language.get({key: "L-206"}) + "</th>" +
                                '                            <th style="width:10%; text-align:center;" data-language="L-152">' + Language.get({key: "L-152"}) + "</th>" +
                                '                            <th style="width:50%;" data-language="L-207">' + Language.get({key: "L-207"}) + "</th>" +
                                '                            <th style="text-align:right;"  data-language="L-244">' + Language.get({key: "L-244"}) + "</th>" +
                                '                            <th style="text-align:right;"  data-language="L-245">' + Language.get({key: "L-245"}) + "</th>" +
                                "                        </tr>" +
                                "                    </thead>" +
                                "                    <tfoot>" +
                                "                    <tbody>" +
                                "        </tbody>" +
                                "    </table>" +
                                "</div>";
                    }

                    //------------------------------------------------------------------


                    parent = '<div data-list="wagers" class="remove-after">' + el + '</div>';
                    //------------------------------------------------------------------

                    $.ajax({
                        url: this.path + param.operation,
                        cache: false,
                        data: param,
                        type: "POST",
                        beforeSend: function () {

                            UI.setLoad({
                                el: $('[data-page]'),
                                class: 'big-load'
                            });
                        },
                        success: function (data) {

                            options.content.prepend(parent);
                            //--------------------------------------------------

                            var risk = 0;
                            var win = 0;
                            var ticketWaggerTemp = '';
                            //--------------------------------------------------

                            for (var i = 0; i < data.Pending.length; i++) {

                                var item = data.Pending[i];
                                var gameTicketWagger = item.TicketNumber + '-' + item.WagerNumber;
                                if (gameTicketWagger != ticketWaggerTemp) {

                                    ticketWaggerTemp = gameTicketWagger;
                                    var singleWagerType = "SMLECA";
                                    var openSpots = "";
                                    var description = "";
                                    var descriptionMobile = "";
                                    var detailsMobile = "";
                                    var freePlay = "";
                                    var flag = false;


                                    var param = {
                                        ticketNumber: item.TicketNumber,
                                        wagerNumber: item.WagerNumber,
                                        totalPicks: item.totalPicks,
                                        win: (item.ToWinAmount / 100).toFixed(2),
                                        risk: (item.AmountWagered / 100).toFixed(2),
                                        description: item.Description.toString().split(" ").join(Util.concat.PARAM),
                                        spotsAvailable: parseInt(item.WagerCount)
                                    };

                                    risk += parseFloat(param.risk);
                                    win += parseFloat(param.win);

                                    //------------------------------------------------------

                                    var detail = {
                                        ticketNumber: item.TicketNumber,
                                        wagerNumber: item.WagerNumber,
                                        flag: item.WagerType
                                    };

                                    //------------------------------------------------------

                                    if (Util.isMobile()) {



                                        var wagerDescriptionFormat = "<div class='col-md-12 col-sm-12 col-xs-12 wagerPendingMobile'>" +
                                                "<div class='col-md-4 col-sm-4 col-xs-4'>" +
                                                "<label class='normalDescription'>{Header}</label>" +
                                                "</div>" +
                                                "<div class='col-md-8 col-sm-8 col-xs-8 BOLA-1'>" +
                                                "<label class='normalDescription'>{Content}</label>" +
                                                "</div>" +
                                                "</div>";


                                        var wagerData = data.Pending.filter(function (el) {
                                            return el.TicketNumber == item.TicketNumber && el.WagerNumber == item.WagerNumber;
                                        });

                                        if (!singleWagerType.includes(item.WagerType)) {


                                            var commentH = '';

                                            if (item.Comments !== null && item.Comments !== '') {
                                                commentH = wagerDescriptionFormat.replace("{Header}", ("Game Note :")).replace("{Content}", item.Comments);
                                            }


                                            var rotationNumber = _self.getRotationNumber({Team1ID: item.Team1ID, ChosenTeamID: item.ChosenTeamID, Team1RotNum: item.Team1RotNum, Team2RotNum: item.Team2RotNum});
                                            var wagerType = _self.getTypeInfo({item: item, birdCage: item.ARBirdcageLink, wagerType: item.WagerType, roundRobin: item.RoundRobinLink, ARLink: item.ARLink, totalPicks: item.totalPicks});
                                            wagerDescriptionFormat = wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-38"}) + "#:")).replace("{Content}", "<b>" + item.TicketNumber + "</b>") +
                                                    wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-423"}) + ":")).replace("{Content}", _self.getWagerStatus({WagerStatus: item.WagerStatus})) +
                                                    wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-38"}) + "#:")).replace("{Content}", "<b>" + item.TicketNumber + "</b>") +
                                                    wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-206"}) + ":")).replace("{Content}", $.format.date(item.AcceptedDateTime.split(".")[0], "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT) +
                                                    wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-425"}) + ":")).replace("{Content}", item.PlacedOn) +
                                                    commentH;//((item.Comments !== '') ? wagerDescriptionFormat.replace("{Header}", ("Game Note :")).replace("{Content}", item.Comments) : '');

                                            detailsMobile += wagerDescriptionFormat + _self.getResultTicketMobileDetails(wagerData);

                                        } else {
                                            detailsMobile += _self.getResultTicketMobileDetails(wagerData);
                                        }


                                        descriptionMobile += _self.getResultTicketMobile(wagerData);

                                        //------------------------------------------------------
                                    } else {


                                        var wagerDescriptionFormat =
                                                "<div data-group='" + item.TicketNumber + "-" + item.WagerNumber + "' class='hidden ticketNumberDescription'>" +
                                                "<div class='col-md-12 col-sm-12 col-xs-12'>" +
                                                "<div class='col-md-3 col-sm-3 col-xs-3'>" +
                                                "<label class='normalDescription'>{Header}</label>" +
                                                "</div>" +
                                                "<div class='col-md-9 col-sm-9 col-xs-9'>" +
                                                "<label class='normalDescription'>{Content}</label>" +
                                                "</div>" +
                                                "</div>" +
                                                "</div>";

                                        var rotationNumber = _self.getRotationNumber({Team1ID: item.Team1ID, ChosenTeamID: item.ChosenTeamID, Team1RotNum: item.Team1RotNum, Team2RotNum: item.Team2RotNum});
                                        var wagerType = (item.WagerType === "C" ? "" : _self.getTypeInfo({item: item, birdCage: item.ARBirdcageLink, wagerType: item.WagerType, roundRobin: item.RoundRobinLink, ARLink: item.ARLink, totalPicks: item.totalPicks}));

                                        if (!singleWagerType.includes(item.WagerType)) {

                                            var commentH = '';

                                            if (item.Comments !== null && item.Comments !== '') {
                                                commentH = wagerDescriptionFormat.replace("{Header}", ("Game Note :")).replace("{Content}", item.Comments);
                                            }



                                            var game = (item.WagerType === 'C') ? item.Team2ID : item.Team1ID + ' / ' + item.Team2ID;
                                            description += wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-38"}) + "#:")).replace("{Content}", "<label>" + item.TicketNumber + "</label>") +
                                                    wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-423"}) + ":")).replace("{Content}", _self.getWagerStatus({WagerStatus: item.WagerStatus})) +
                                                    wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-244"}) + "/" + Language.get({key: "L-393"}) + ":")).replace("{Content}", "<label>" + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.AmountWagered / 100}) + " / " + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.ToWinAmount / 100})) + "</label>" +
                                                    wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-206"}) + ":")).replace("{Content}", $.format.date(item.AcceptedDateTime.split(".")[0], "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT) +
                                                    wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-425"}) + ":")).replace("{Content}", item.PlacedOn) +
                                                    commentH;//((item.Comments !== '') ? wagerDescriptionFormat.replace("{Header}", ("Game Note :")).replace("{Content}", item.Comments) : '');

                                            //-------- Carga la informacion de los juegos --------//    

                                            var wagerData = data.Pending.filter(function (el) {
                                                return el.TicketNumber == item.TicketNumber && el.WagerNumber == item.WagerNumber;
                                            });

                                            description += _self.getResultTicketPending(wagerData);

                                        } else {

                                            //-------- Carga la informacion de los juegos --------//    

                                            var wagerData = data.Pending.filter(function (el) {
                                                return el.TicketNumber == item.TicketNumber && el.WagerNumber == item.WagerNumber;
                                            });
                                            description += _self.getResultTicketPending(wagerData);


                                            var game = (item.WagerType === 'C') ? item.Team2ID : item.Team1ID + ' / ' + item.Team2ID;

                                            var commentH = '';

                                            if (item.Comments !== null && item.Comments !== '') {
                                                commentH = wagerDescriptionFormat.replace("{Header}", ("Game Note :")).replace("{Content}", item.Comments);
                                            }


                                            if (item.WagerType === 'C') {

                                                description += wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-38"}) + "#:")).replace("{Content}", "<label>" + item.TicketNumber + "</label>") +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-423"}) + ":")).replace("{Content}", _self.getWagerStatus({WagerStatus: item.WagerStatus})) +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-244"}) + "/" + Language.get({key: "L-393"}) + ":")).replace("{Content}", "<label>" + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.AmountWagered / 100}) + " / " + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.ToWinAmount / 100})) + "</label>" +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-237"}) + ":")).replace("{Content}", game) +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-426"}) + ":")).replace("{Content}", $.format.date(item.GameDateTime.split(".")[0], "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT) +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-206"}) + ":")).replace("{Content}", $.format.date(item.AcceptedDateTime.split(".")[0], "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT) +
                                                        wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-425"}) + ":")).replace("{Content}", item.PlacedOn) +
                                                        commentH;// ((item.Comments !== '') ? wagerDescriptionFormat.replace("{Header}", ("Game Note :")).replace("{Content}", item.Comments) : '');

                                            } else {

                                                if (item.WagerType === 'G') {

                                                    description += //wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-38"}) + "#:")).replace("{Content}", "<label>" + item.TicketNumber + "</label>") +
                                                            wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-423"}) + ":")).replace("{Content}", _self.getWagerStatus({WagerStatus: item.WagerStatus})) +
                                                            wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-244"}) + "/" + Language.get({key: "L-393"}) + ":")).replace("{Content}", "<label>" + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.AmountWagered / 100}) + " / " + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.ToWinAmount / 100})) + "</label>" +
                                                            wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-237"}) + ":")).replace("{Content}", game) +
                                                            wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-424"}) + ":")).replace("{Content}", ((item.WagerType === 'L') ? item.Team1RotNum + '/' + item.Team2RotNum : rotationNumber) + "   " + item.PeriodDescription.trim() + " " + wagerType) +
                                                            wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-426"}) + ":")).replace("{Content}", $.format.date(item.GameDateTime.split(".")[0], "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT) +
                                                            wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-206"}) + ":")).replace("{Content}", $.format.date(item.AcceptedDateTime.split(".")[0], "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT) +
                                                            wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-425"}) + ":")).replace("{Content}", item.PlacedOn) +
                                                            commentH;// ((item.Comments !== '') ? wagerDescriptionFormat.replace("{Header}", ("Game Note :")).replace("{Content}", item.Comments) : '');

                                                } else {

                                                    var pitcher = '';

                                                    switch (item.SportType.toString().toUpperCase().trim()) {

                                                        case Util.SPORT.BASEBALL:

                                                            if (item.ListedPitcher1 !== null) {

                                                                pitcher = '<br><div class="pitcher-pending">( ' +
                                                                        item.ListedPitcher1 + ' ' + Util.pitcherAction({type: item.Pitcher1ReqFlag}) + ' / ' +
                                                                        item.ListedPitcher2 + ' ' + Util.pitcherAction({type: item.Pitcher2ReqFlag}) + ' )</div>';
                                                            }

                                                            break;
                                                    }

//                                                    if (item.PeriodNumber > 0) {
//
//                                                        pitcher + ' - ' + item.PeriodDescription.toString().trim() + ' - ';
//
//                                                    }


                                                    //--------------------------

                                                    description += wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-38"}) + "#:")).replace("{Content}", "<label>" + item.TicketNumber + "</label>") +
                                                            wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-423"}) + ":")).replace("{Content}", _self.getWagerStatus({WagerStatus: item.WagerStatus})) +
                                                            wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-244"}) + "/" + Language.get({key: "L-393"}) + ":")).replace("{Content}", "<label>" + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.AmountWagered / 100}) + " / " + Util.currency[Customer.accountInfo.CurrencyCode] + " " + Util.formatCurrency({val: item.ToWinAmount / 100})) + "</label>" +
                                                            wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-237"}) + ":")).replace("{Content}", game) +
                                                            wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-424"}) + ":")).replace("{Content}", ((item.WagerType === 'L') ? item.Team1RotNum + '/' + item.Team2RotNum : rotationNumber) + "   " + item.PeriodDescription.trim() + " " + wagerType + pitcher) +
                                                            wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-426"}) + ":")).replace("{Content}", $.format.date(item.GameDateTime.split(".")[0], "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT) +
                                                            wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-206"}) + ":")).replace("{Content}", $.format.date(item.AcceptedDateTime.split(".")[0], "E M/d hh:mm a") + ' ' + Util.timeZone[Customer.accountInfo.TimeZone.toString().replace('-', '')].SHORT) +
                                                            wagerDescriptionFormat.replace("{Header}", (Language.get({key: "L-425"}) + ":")).replace("{Content}", item.PlacedOn) +
                                                            commentH;//((item.Comments !== '') ? wagerDescriptionFormat.replace("{Header}", ("Game Note :")).replace("{Content}", item.Comments) : '');
                                                }



                                            }


                                        }

                                    }


                                    if (data.Pending[i].WagerStatus == Util.status.OPEN) {
                                        openSpots = " <button " + 'data-action="open-spots" ' + "data-param=" + JSON.stringify(param) + ' data-type="' + data.Pending[i].WagerType + '" ' + 'class="btn btn-info btn-sm" >' + "( " + data.Pending[i].WagerCount + " ) " + (Util.isMobile() ? Language.get({key: "L-418"}) : Language.get({key: "L-68"})) + "</button>";
                                    }

                                    //------------------------------------------------------

                                    if (item.FreePlayFlag == "Y") {
                                        freePlay = '<span class="label label-primary freeplaySpan">' + Language.get({key: 'L-419'}) + '</span>';
                                    }

                                    //------------------------------------------------------

                                    var element = "";
                                    var footer = "";

                                    if (Util.isMobile()) {

                                        var type = (singleWagerType.includes(item.WagerType)) ? "" : _self.getTypeInfo({item: data.Pending[i], birdCage: data.Pending[i].ARBirdcageLink, wagerType: data.Pending[i].WagerType, roundRobin: data.Pending[i].RoundRobinLink, ARLink: data.Pending[i].ARLink, totalPicks: data.Pending[i].totalPicks})
                                        //var title = (type != '') ? '<label class="normalDescription">' + type + '</label>' + openSpots + '</br>' : '<b>' + openSpots + '</b>';
                                        var title = (type != '') ? type + openSpots + '</br>' : '<b>' + openSpots + '</b>';

                                        var freePlay = '';

                                        if (item.FreePlayFlag == "Y") {
                                            freePlay = '<span style=" color: white; margin: 0px 2px; " class="label label-primary freeplaySpan">' + Language.get({key: 'L-419'}) + '</span>';
                                        }

                                        element =
                                                '<div class="row headerWager"  data-action="show-ticket-detail" data-ticket=' + item.TicketNumber + '-' + item.WagerNumber + ">" +
                                                '<div class="detailsHeaderWagerMobile">' +
                                                '<div class="col-xs-7 detailsWagerMobile">' + title + descriptionMobile + "</div>" +
                                                '<div class="col-xs-2 detailsWagerMobileRisk" data-risk=' + param.risk + '>' +
                                                freePlay + '<span  class="value-Risk">' + Util.getCurrency(Customer.accountInfo.CurrencyCode) + Util.formatCurrency({val: param.risk}) + "</span>" +
                                                "</div>" +
                                                '<div class="col-xs-2 detailsWagerMobileWin" data-win=' + param.win + '>' +
                                                '<span  class="value">' + Util.getCurrency(Customer.accountInfo.CurrencyCode) + Util.formatCurrency({val: param.win}) + "</span>" +
                                                "</div>" +
                                                '</div>' +
                                                '<div class="detailsBodyWagerMobile hidden" data-details="detailsWagger" data-group=' + item.TicketNumber + '-' + item.WagerNumber + ">" +
                                                detailsMobile +
                                                "</div>" +
                                                "</div>";






                                        //--------------------------------------------------

                                        $('[data-list="wagers"]').append(element);

                                        $('b:empty').remove();

                                    } else {
                                        element =
                                                '<tr class="header" data-ticket=' + item.TicketNumber + '-' + item.WagerNumber + '>' +
                                                '<td class="tableColumnFixed leftAlign">' + $.format.date(item.AcceptedDateTime.split(".")[0], "E M/d hh:mm a") + "</br>" + openSpots + "</td>" +
                                                '<td class="tableColumnFixed leftAlign">' + _self.getTypeInfo({item: item, birdCage: data.Pending[i].ARBirdcageLink, wagerType: data.Pending[i].WagerType, roundRobin: data.Pending[i].RoundRobinLink, ARLink: data.Pending[i].ARLink, totalPicks: data.Pending[i].totalPicks}) + "</td>" +
                                                '<td class="tableColumnFixed leftAlign">' + description + "</td> " +
                                                '<td style="width: 160px;color: red;text-align:right;" data-risk="' + param.risk + '">' + freePlay + Util.getCurrency(Customer.accountInfo.CurrencyCode) + Util.formatCurrency({val: param.risk}) + "</td>" +
                                                '<td style="width: 160px;text-align:right;" data-win="' + param.win + '">' + Util.getCurrency(Customer.accountInfo.CurrencyCode) + Util.formatCurrency({val: param.win}) + "</td> " +
                                                "</tr>"

                                        //--------------------------------------------------


                                        $('[data-list="wagers"] tbody').append(element);

                                        $('b:empty').remove();
                                    }

                                    //------------------------------------------------------
                                }

                            }

                            //--------------------------------------------------

                            var _line = require('customer/line/line');
                            var Line = new _line();
                            var title = 'Main Menu';
                            //--------------------------------------------------

                            if (Line.layout.SELECTED === Line.layout.FAST_WAY.desktop ||
                                    $(window).width() > 700) {

                                title = 'Continue';
                            }

                            //--------------------------------------------------

                            _self.listeners();
                            //--------------------------------------------------

                            options.content.prepend('<div class="msg-header-confirmed remove-after"><i class="fa fa-check-circle"></i><span>Ticket Number : ' + options.ticketNumber + '</span></div>');
                            options.content.append('<div class="controls-confirmed remove-after"> ' +
                                    '<button data-action="go-pending" class="pending-b" type="button">Pending Wagers</button> ' +
                                    '<button data-action="go-home" class="main-menu-b"  type="button">' + title + '</button> ' +
                                    '</div>');
                            //----------------------------------------------------------

                            UI.removeElement({el: $('[data-page] [data-control="load"]'), time: 1});
                            //----------------------------------------------------------

                            options.content.find('[data-action="go-pending"]').on('click', function () {

                                $('[data-action="show-pending"]').trigger('click');
                                $('.remove-after').remove();
                            });
                            options.content.find('[data-action="go-home"]').on('click', function () {

                                var _class = require('customer/line/league');
                                var League = new _class();

                                if (!Util.isMobile()) {
                                    $('[data-panel="center"]').removeClass().addClass('col-lg-10 col-md-9 col-sm-8 col-xs-12');
                                    $('[data-panel="left"],.tools').show();
                                    $('.tools').removeClass('hidden');

                                    $("#select-wager select").val(Util.BET.TYPE.STRAIGHT.val);
                                    $("#select-wager select").selectpicker("render");

                                }


                                //-----------------------------------------------------

                                $('.teaser-desktop-selector').remove();

                                //------------------------------------------------------

                                Util.__proto__.BET.SELECTED = Util.BET.TYPE.STRAIGHT.val;

                                //------------------------------------------------------


                                if (Util.isOnlyMobile()) {

                                    $("#select-wager select").trigger('change');

                                } else {

                                    Line.getUpcomingLines({
                                        hour: 0,
                                        keyword: Util.upcoming.MAJOR_EVENTS
                                    });

                                    League.getSportsLeagues();

                                }




                                //------------------------------------------------------

                                $('[data-content="leagues"] [data-action="get-lines"]').find('div').removeClass('checked');




                                return false;

                                var _wager = require('customer/wager/wager');
                                var Wager = new _wager();

                                Wager.listeners();


                                if (Line.layout.SELECTED === Line.layout.FAST_WAY.desktop ||
                                        $(window).width() > 700) {


                                    var rowLine = $('.row-line');
                                    switch (Util.BET.SELECTED) {

                                        case Util.BET.TYPE.TEASER.val:


                                            //$('[data-panel="teaser"] [data-league]').first().trigger('click');
                                            // $('.bootstrap-select.teaser-desktop-selector').remove();
                                            $('#teaser-offers').css('display', 'inline-block');
                                            rowLine.find('input[type="checkbox"]').iCheck('uncheck');
                                            $('#select-wager select').trigger('change');
                                            break

                                            //------------------------------------------------------

                                        default:

                                            $('.teaser-desktop-selector').remove();
                                            // $('[data-content="leagues"] [data-action="get-lines"]').find('div').removeClass('checked');



                                            rowLine.find('input[type="text"]').val('').removeClass('active error');
                                            rowLine.find('input[type="checkbox"]').iCheck('uncheck');
                                            rowLine.find('input[type="text"]').val('').removeClass('active error');
                                            rowLine.find('[data-display]').removeClass('active-multi').find('button').removeClass('active');
                                            if (Line.layout.SELECTED === Line.layout.FAST_WAY.desktop) {
                                                $('[data-action="place-wagers"]').show();
                                            }




                                            UI.showPage({page: $('[data-page="line"]')});
                                            break;
                                    }

                                    //-------------------------------------------------------



                                    $('.remove-after').remove();
                                } else {

                                    $('[data-action="show-search"]').trigger('click');
                                    $('.remove-after').remove();
                                }



                            });
                        }
                    });
                },
                //--------------------------------------------------------------
                getUIBuyOut: function (options) {

                    var _self = this;

                    UI.getComponent({
                        component: _self.componentPathBase + "modal-buyout",
                        func: _self.setUIBuyOut,
                        info: {
                            self: _self,
                            data: options.data,
                            el: options.el
                        }
                    });

                },
                //--------------------------------------------------------------
                setUIBuyOut: function (options) {

                    var _self = options.info.self;
                    var component = options.component;
                    var info = $.parseJSON(options.info.data);
                    var el = options.info.el;
                    var parent = el.closest('[data-list="wagers"]');
                    var _customer = require("customer/customer");
                    var Customer = new _customer();
                    var checking = {};

                    var picks = '';

                    if (Util.isOnlyMobile()) {

                        picks = parent.find('.row.headerWager[data-ticket="' + info.ticketNumber + '-' + info.wagerNumber + '"]').clone();

                        picks.find('.detailsHeaderWagerMobile')
                                .prepend('<span class="ticket-header">Ticket #' + info.ticketNumber + '</span>');

                    } else {
                        picks = el.closest('td').clone();

                        picks.prepend('<div class="header-h">' +
                                '<span class="s-1">Parlay - ' + info.totalPicks + ' Teams</span> ' +
                                '<span class="s-2">Ticket #' + info.ticketNumber + '</span> ' +
                                '</div>');

                        component.find('.content-teams').addClass('desktop-content');
                    }

                    component.find('.content-teams').html(picks);


                    component.find('.content-teams').attr('data-teams', info.ticketNumber + '-1');


                    checking = _self.checkingBuyOut(info, 1);

                    //----------------------------------------------------------

                    if (checking.result === 'Y') {

                        var winAmountA = info.winAmount / 100;
                        var winAmount = info.winAmount / 100;

//                        winAmount = winAmountA * 0.15;
//                        winAmount = winAmountA - (winAmountA * 0.15);

                        $('.modal-buyout').remove();

                        var payout = Util.currency[Customer.accountInfo.CurrencyCode]
                                + " " + Util.formatCurrency({val: winAmount});

                        var payoutBuyOut = Util.currency[Customer.accountInfo.CurrencyCode]
                                + " " + Util.formatCurrency({val: checking.amount / 100});

                        component.find('[data-field="payout-pay"]').html(payout);
                        component.find('[data-field="buyout-pay"]').html(payoutBuyOut);

                        component.find('[data-field="count-picks"]').html(info.totalPicks);
                        component.find('[data-field="count-picks-win"]').html(picks.find('[data-status="W"]').length);

                        $('body').append(component.html());

                        $('[data-action="show-confirm-buyout"]').off().on('click', function () {

                            checking = _self.checkingBuyOut(info, 1);

                            if (checking.result === 'Y') {
                                $('#modal-check-buyout').modal('hide');
                                $('#modal-confirm-buyout').modal('show');
                            } else {

                                Message.showMsg({
                                    title: Language.get({key: 'L-21'}),
                                    text: checking.result,
                                    icon: Message.type.ERROR.icon,
                                    time: 10000
                                });
                            }



                        });

                        //------------------------------------------------------

                        $('[data-action="process-buyout"]').off().on('click', function () {

                            checking = _self.checkingBuyOut(info, 0);

                            if (checking.result === 'Y') {

                                $('#modal-confirm-buyout').modal('hide');

                                Message.showMsg({
                                    title: Language.get({key: 'L-24'}),
                                    text: Language.get({key: 'L-363'}),
                                    icon: Message.type.CONFIRMATION.icon,
                                    time: 5000
                                });

                                //---------------------------------------------

                                Customer.getAccountInfo();
                                _self.getPendingWagers();

                            } else {

                                Message.showMsg({
                                    title: Language.get({key: 'L-21'}),
                                    text: checking.result,
                                    icon: Message.type.ERROR.icon,
                                    time: 10000
                                });
                            }



                        });

                        //------------------------------------------------------

                        $('div[data-teams]').off().on('click', function () {

                            $(this).find('[data-group="' + $(this).attr('data-teams') + '"]').toggleClass('hidden');

                        });

                        //------------------------------------------------------

                        if (Util.isOnlyMobile()) {
                            if ($('#modal-check-buyout').find('.col-md-12.col-sm-12.col-xs-9.wagerPendingMobile.type-content-P').hasClass('hidden')) {

                                $('#modal-check-buyout').find('div[data-teams]').trigger('click');

                            }
                        } else {

                            if (!$('#modal-check-buyout').find('.ticketNumberDescription').first().hasClass('hidden')) {

                                $('#modal-check-buyout').find('div[data-teams]').trigger('click');

                            }

                        }



                        //------------------------------------------------------

                        $('#modal-check-buyout').modal('show');

                    } else {

                        Message.showMsg({
                            title: Language.get({key: 'L-21'}),
                            text: checking.result,
                            icon: Message.type.ERROR.icon,
                            time: 10000
                        });

                    }

                    //-----------------------------------------------------------

                },
                //--------------------------------------------------------------
                checkingBuyOut: function (info, simulate) {

                    var _customer = require("customer/customer");
                    var Customer = new _customer();
                    var _self = this;

                    var checking = {};
                    var paramAdd = {
                        customerID: Customer.ID,
                        token: Security.token,
                        simulate: simulate,
                        ticketNumber: info.ticketNumber,
                        wagerNumber: info.wagerNumber,
                        operation: 'buyOutProcess'
                    };

                    //----------------------------------------------------------


                    $.ajax({
                        url: _self.path + paramAdd.operation,
                        cache: false,
                        data: paramAdd,
                        type: "POST",
                        async: false,
                        success: function (data) {

                            checking = data.INFO;

                        }
                    });


                    return checking;


                }
            });
        }
);