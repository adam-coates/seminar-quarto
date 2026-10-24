/*****************************************************************
** Author: Asvin Goel, goel@telematique.eu
**
** A plugin for reveal.js adding instant polls within an
** online seminar.
**
** Version: 0.1.1
**
** License: MIT license (see LICENSE.md)
**
******************************************************************/

// Assigned outright, not `window.RevealPoll || ...` as upstream has it. This
// file is a fork: it carries the late-joiner relay, the active-poll tracking and
// the voter counting that the deck depends on. Deferring to whatever got there
// first is how the upstream build off the CDN silently replaced it.
window.RevealPoll = {
    id: 'RevealPoll',
    init: function(deck) {
        initPoll(deck);
    },
};


const initPoll = function(Reveal){
	var LP = window.Livepoll;
	// livepoll.js stays out of a PDF export (?print-pdf), and so does this
	if (!LP) return this;

	var polls = [];
    let currentPollId = null;

	// Get poll index
	function getPollIndex(id) {
		return polls.findIndex(poll => poll.id === id);
	}

	function getPoll(id) {
		return polls[getPollIndex(id)] || null;
	}

	// How many choices a poll takes: 1 unless livepoll.lua says otherwise
	// (max-choices="N", or multiple="true" for 0, meaning any number).
	function maxChoices(id) {
		var def = (LP.config().polls || {})[id];
		if (!def || def.maxChoices === undefined || def.maxChoices === null) return 1;
		return Number(def.maxChoices);
	}

	// A round of voting. Peer instruction asks the same question twice — vote,
	// talk to a neighbour, vote again — so a poll keeps its rounds in order and
	// counts the last. `seen` is who has voted in this round (LP.claim).
	function newRoundState(options) {
		var votes = {};
		options.forEach(function(value){ votes[value] = 0; });
		return { votes: votes, voters: 0, seen: {} };
	}

	function current(poll) {
		return poll.rounds[poll.rounds.length - 1];
	}

	// The earlier rounds, as the results message carries them.
	function history(poll) {
		return poll.rounds.slice(0, -1).map(function(r){
			return { votes: r.votes, voters: r.voters };
		});
	}

	function initializePolls() {
		var pollElements = document.querySelectorAll(".poll");
//console.log(polls);
		for (var i = 0; i < pollElements.length; i++ ){
			var id = pollElements[i].getAttribute('data-poll')
			var options = [];
			var buttons = pollElements[i].querySelectorAll("button");
			for (var j = 0; j < buttons.length; j++ ){
				options.push(buttons[j].getAttribute('data-value'));

				// make button clickable
				buttons[j].addEventListener('click', onButton);
			}
			// The same poll can be on two slides; one tally.
			if (getPoll(id)) continue;
			// lastResults: per poll. It used to be one variable shared by every
			// poll on the deck, so a tally that happened to match the one seen
			// last — easily the case when two questions have the same options —
			// was mistaken for a duplicate and the chart never redrew.
			polls.push( { id, options, rounds: [ newRoundState(options) ], lastResults: null } );
//console.log(polls);
		}

		// a poll taking several choices has a Submit button beside it
		document.querySelectorAll('.poll-submit[data-poll]').forEach(function(submit){
			submit.addEventListener('click', function(){
				var id = submit.getAttribute('data-poll');
				var chosen = [];
				document.querySelectorAll('.poll[data-poll="' + id + '"] button.selected').forEach(function(b){
					chosen.push(b.getAttribute('data-value'));
				});
				if (!chosen.length) return;
				if ( !RevealSeminar.connected() ) {
					alert("You are currently not connected to the live poll. Your vote is ignored.");
					return;
				}
				document.querySelectorAll('.poll[data-poll="' + id + '"] button').forEach(function(b){ b.disabled = true; });
				submit.disabled = true;
				submit.textContent = 'Sent';
				vote(id, chosen);
			});
		});
	}

	function onButton(evt){
		// currentTarget, not target: a panel-layout button holds the
		// label, bar and count as spans, and a click lands on those.
		const button = evt.currentTarget;
		const poll = button.closest('.poll');
		const id = poll.getAttribute('data-poll');
		const max = maxChoices(id);

		if (max !== 1) {
			// several choices: toggle, and send them with Submit
			var picked = poll.querySelectorAll('button.selected').length;
			if (!button.classList.contains('selected') && max > 0 && picked >= max) return;
			button.classList.toggle('selected');
			button.blur();
			var submit = document.querySelector('.poll-submit[data-poll="' + id + '"]');
			if (submit) submit.disabled = !poll.querySelector('button.selected');
			return;
		}

		if ( !RevealSeminar.connected() ) {
			alert("You are currently not connected to the live poll. Your vote is ignored.");
			return;
		}
		var siblings = poll.querySelectorAll("button");
		for (var i = 0; i < siblings.length; i++ ){
			siblings[i].disabled = true;
		}
		vote( id, button.getAttribute('data-value') );
		button.classList.add("selected");
		button.blur();
	}

	// Send the vote to the chair: one value, or a list for a poll that takes
	// several.
	function vote( poll, choice ) {
		var content = { sender: 'poll-plugin', type: 'vote', poll };
		if (Array.isArray(choice)) content.choices = choice;
		else content.choice = choice;
		LP.toHost(content);
	}

	// The choices in a vote message, checked against the poll: each one it
	// offers, none twice, no more than it takes. Null if the vote is no good.
	function choicesOf(poll, content) {
		var max = maxChoices(poll.id);
		var list = Array.isArray(content.choices) ? content.choices : [content.choice];
		if (!list.length || (max > 0 && list.length > max)) return null;
		var seen = {};
		for (var i = 0; i < list.length; i++) {
			var c = list[i];
			// A choice this poll does not offer would put NaN in the tally and
			// take the whole chart out with it.
			if (typeof c !== 'string' || current(poll).votes[c] === undefined || seen[c]) return null;
			seen[c] = true;
		}
		return list;
	}

	function broadcastTally(poll) {
		var round = current(poll);
		LP.broadcast({ sender: 'poll-plugin', copy: true, type: 'voters', poll: poll.id, voters: round.voters });
		LP.broadcast({
			sender: 'poll-plugin', copy: true, type: 'results', poll: poll.id,
			votes: round.votes, voters: round.voters, round: poll.rounds.length, history: history(poll),
		});
	}

	// Host: open another round of the same question. Everyone may vote again;
	// the earlier rounds stay, and the slide draws them side by side.
	function newRound(id) {
		var poll = getPoll(id);
		if (!poll || !LP.hosting()) return false;
		poll.rounds.push(newRoundState(poll.options));
		poll.lastResults = null;
		LP.broadcast({ sender: 'poll-control', copy: true, type: 'start-round', pollId: id, round: poll.rounds.length, session: LP.sessionId() });
		if (!LP.isOpen(id)) LP.reopen(id);
		broadcastTally(poll);
		LP.log('Round ' + poll.rounds.length + ' of ' + id);
		document.dispatchEvent(new CustomEvent('livepoll-round', { detail: { id: id, round: poll.rounds.length } }));
		LP.dirty();
		return true;
	}

	LP.newRound = newRound;
	LP.roundOf = function(id) {
		var poll = getPoll(id);
		return poll ? poll.rounds.length : 1;
	};

	LP.kinds.poll = {
		reset: function(id) {
			var poll = getPoll(id);
			if (!poll) return;
			poll.rounds = [ newRoundState(poll.options) ];
			poll.lastResults = null;
			broadcastTally(poll);
		},
		count: function(id) {
			var poll = getPoll(id);
			if (!poll) return null;
			var label = poll.rounds.length > 1 ? 'votes in round ' + poll.rounds.length : 'votes';
			return { n: current(poll).voters, label: label };
		},
	};

	LP.persist('polls', {
		save: function() {
			var out = {};
			polls.forEach(function(poll){
				var used = poll.rounds.length > 1 || current(poll).voters > 0;
				if (used) out[poll.id] = poll.rounds;
			});
			return out;
		},
		restore: function(data) {
			Object.keys(data || {}).forEach(function(id){
				var poll = getPoll(id);
				if (!poll || !Array.isArray(data[id]) || !data[id].length) return;
				poll.rounds = data[id];
				poll.lastResults = null;
				var round = current(poll);
				send({ sender: 'poll-plugin', type: 'voters', poll: id, voters: round.voters });
				send({ sender: 'poll-plugin', type: 'results', poll: id, votes: round.votes, voters: round.voters, round: poll.rounds.length, history: history(poll) });
			});
		},
	});

	// A message to this deck alone, as a restore replays its results.
	function send(content) {
		var event = new CustomEvent('received');
		event.content = content;
		document.dispatchEvent(event);
	}

	// A deck following the host, voting from the slide: a new round gives it
	// its buttons back.
	function enableButtons(id) {
		document.querySelectorAll('.poll[data-poll="' + id + '"] button').forEach(function(b){
			b.disabled = false;
			b.classList.remove('selected');
		});
		var submit = document.querySelector('.poll-submit[data-poll="' + id + '"]');
		if (submit) {
			submit.disabled = true;
			submit.textContent = 'Submit';
		}
	}

document.addEventListener('received', function (message) {
  if (!message || !message.content) return;
  const content = message.content;
  // Anyone in the room can send a message to everyone; only what the host
  // announces (or this page replays itself) may change what is shown.
  const trusted = LP.trusted(message);

  // === Handle poll-control messages (activate / deactivate) ===
  if (content.sender === 'poll-control') {
    if (!trusted) return;
    if (content.type === 'activate-poll') {
      // set active poll id (ignore exact duplicates)
      if (currentPollId === content.pollId) return;
      currentPollId = content.pollId;
      // let the normal broadcast flow continue (so everyone receives the activation once)
      // NOTE: we do NOT change broadcast behaviour here; we only keep track of the id
      return;
    } else if (content.type === 'deactivate-poll') {
      currentPollId = null;
      return;
    } else if (content.type === 'start-round') {
      if (!LP.hosting()) enableButtons(content.pollId);
      return;
    }
  }

  // === Handle poll-plugin messages (votes/results/voters) ===
  if (content.sender && content.sender === 'poll-plugin') {
    // a vote: update server-side representation (the plugin assumed presenter does this)
    if (content.type == 'vote') {
      if (!LP.hosting()) return;
      const poll = getPoll(content.poll);
      if (!poll || !LP.isOpen(poll.id)) return;

      const choices = choicesOf(poll, content);
      if (!choices) return;

      // Count people, not messages: by device and by connection (LP.claim).
      // Each round has its own record, so a new round is a new vote.
      const round = current(poll);
      if (!LP.claim(round.seen, message, content)) return; // already voted: a reload, not a person
      round.voters++;
      choices.forEach(function(c){ round.votes[c]++; });

      broadcastTally(poll);
      LP.response({
        kind: 'poll', id: poll.id, who: LP.who(message, content), round: poll.rounds.length,
        value: Array.isArray(content.choices) ? choices : choices[0],
      });
    }

    // voters update (just update DOM)
    else if (content.type == 'voters') {
      if (!trusted) return;
      var votersEls = document.querySelectorAll('.voters[data-poll="' + content.poll + '"]');
      for (var j = 0; j < votersEls.length; j++) {
        votersEls[j].innerHTML = content.voters;
      }
    }

    // results update (dedupe then update DOM/charts)
    else if (content.type == 'results') {
      if (!trusted) return;
      const pollId = content.poll;
      const votes = content.votes;

      // ignore if identical to this poll's own last tally (avoids re-render on join)
      const known = getPoll(pollId);
      if (known) {
        const key = JSON.stringify([votes, content.history || []]);
        if (known.lastResults === key) return;
        known.lastResults = key;
      }

      var results = document.querySelectorAll('.results[data-poll="' + pollId + '"]');
      for (var i = 0; i < results.length; i++) {
        for (var choice in votes) {
          var elements = results[i].querySelectorAll('[data-value="' + choice + '"]');
          for (var j = 0; j < elements.length; j++) {
            elements[j].innerHTML = votes[choice];
          }
        }
      }

      // update result charts
      if (RevealChart) {
        var charts = document.querySelectorAll('canvas[data-chart][data-poll="' + pollId + '"]');
        var data = [];
        for (var choice in votes) data.push(votes[choice]);
        for (var i = 0; i < charts.length; i++) {
          if (charts[i].chart) RevealChart.update(charts[i], 0, data);
        }
      }
    }
  }
});

    // A participant who joins late gets the tally so far, from the host alone
    // (livepoll.js sends the activation itself).
    document.addEventListener('welcome', function (evt) {
  // only hosts should respond
  if (!LP.hosting()) return;
  const active = LP.active();
  const user = evt && evt.content && evt.content.user;
  if (!active || !user || !user.id) return;
  const poll = getPoll(active);
  if (!poll) return;
  const round = current(poll);
  LP.sendTo(user.id, { sender: 'poll-plugin', type: 'results', poll: poll.id, votes: round.votes, voters: round.voters, round: poll.rounds.length, history: history(poll) });
  LP.sendTo(user.id, { sender: 'poll-plugin', type: 'voters', poll: poll.id, voters: round.voters });
});

	Reveal.addEventListener('ready', function(){
//alert("READY");
		initializePolls();
	});

	return this;
};
