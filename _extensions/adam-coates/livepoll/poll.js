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
	var config = Reveal.getConfig().poll;

	var polls = [];
    let currentPollId = null;

	// Get poll index
	function getPollIndex(id) {
		return polls.findIndex(poll => poll.id === id);
	}

	// The relay names the sender of every message, but the shape is its own
	// business: a socket id string on some versions, a user object like the one
	// the `welcome` event carries on others. Anything unrecognised counts as no
	// identity at all rather than as one shared voter, which is what using the
	// value directly as a key would silently do.
	function voterKey(sender) {
		if (!sender) return null;
		if (typeof sender === 'string') return sender;
		return sender.id || sender.name || null;
	}

	function initializePolls() {
		var pollElements = document.querySelectorAll(".poll");
//console.log(polls);
		for (var i = 0; i < pollElements.length; i++ ){
			var id = pollElements[i].getAttribute('data-poll')
			var votes = {};
			var buttons = pollElements[i].querySelectorAll("button");
			for (var j = 0; j < buttons.length; j++ ){
				// initialize number of votes for button
				votes[buttons[j].getAttribute('data-value')] = 0; 

				// make button clickable
				buttons[j].addEventListener('click', function(evt){
					if ( !RevealSeminar.connected() ) {
						alert("You are currently not connected to the live poll. Your vote is ignored.");
						return;
					}
					// currentTarget, not target: a panel-layout button holds the
					// label, bar and count as spans, and a click lands on those.
					const button = evt.currentTarget;
					const poll = button.closest('.poll');
					var siblings = poll.querySelectorAll("button");
					for (var i = 0; i < siblings.length; i++ ){
						siblings[i].disabled = true;
					}
					vote( poll.getAttribute('data-poll'), button.getAttribute('data-value') );
					button.classList.add("selected"); 
					button.blur();
				});
			}
			// voterIds: who has voted, so a reload cannot vote twice and the
			// count is people rather than messages.
			// lastResults: per poll. It used to be one variable shared by every
			// poll on the deck, so a tally that happened to match the one seen
			// last — easily the case when two questions have the same options —
			// was mistaken for a duplicate and the chart never redrew.
			polls.push( { id, voters: 0, voterIds: {}, lastResults: null, votes} );
//console.log(polls);
		}

	}

	function vote( poll, choice ) {
		// send to vote to chair
		var message = new CustomEvent('send');
		message.content = { sender: 'poll-plugin', recipient: true, type: 'vote', poll, choice };
		document.dispatchEvent( message );
	}

document.addEventListener('received', function (message) {
  if (!message || !message.content) return;
  const content = message.content;

  // === Handle poll-control messages (activate / deactivate) ===
  if (content.sender === 'poll-control') {
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
    }
  }

  // === Handle poll-plugin messages (votes/results/voters) ===
  if (content.sender && content.sender === 'poll-plugin') {
    // a vote: update server-side representation (the plugin assumed presenter does this)
    if (content.type == 'vote') {
      const vote = content;
      const idx = getPollIndex(vote.poll);
      if (idx === -1) return;
      const poll = polls[idx];

      // A choice this poll does not offer would put NaN in the tally and take
      // the whole chart out with it.
      if (poll.votes[vote.choice] === undefined) return;

      // Count people, not messages. seminar.js puts the relay's sender id on
      // the event; without one (an older relay) fall back to counting messages,
      // which is what this did before.
      const voter = voterKey(message.sender);
      if (voter) {
        if (poll.voterIds[voter]) return; // already voted: a reload, not a person
        poll.voterIds[voter] = vote.choice;
        poll.voters = Object.keys(poll.voterIds).length;
      } else {
        poll.voters++;
      }

      var m = new CustomEvent('broadcast');
      m.content = { sender: 'poll-plugin', copy: true, type: 'voters', poll: poll.id, voters: poll.voters };
      document.dispatchEvent(m);

      // update results and broadcast
      poll.votes[vote.choice]++;
      m = new CustomEvent('broadcast');
      m.content = { sender: 'poll-plugin', copy: true, type: 'results', poll: poll.id, votes: poll.votes };
      document.dispatchEvent(m);
    }

    // voters update (just update DOM)
    else if (content.type == 'voters') {
      var votersEls = document.querySelectorAll('.voters[data-poll="' + content.poll + '"]');
      for (var j = 0; j < votersEls.length; j++) {
        votersEls[j].innerHTML = content.voters;
      }
    }

    // results update (dedupe then update DOM/charts)
    else if (content.type == 'results') {
      const pollId = content.poll;
      const votes = content.votes;

      // ignore if identical to this poll's own last tally (avoids re-render on join)
      const pollIdx = getPollIndex(pollId);
      if (pollIdx !== -1) {
        const seen = polls[pollIdx].lastResults;
        if (seen && JSON.stringify(votes) === JSON.stringify(seen)) return;
        polls[pollIdx].lastResults = Object.assign({}, votes);
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
        for (var i = 0; i < charts.length; i++) RevealChart.update(charts[i], 0, data);
      }
    }
  }
});

    document.addEventListener('welcome', function (evt) {
  // only hosts should respond
  if (!RevealSeminar.hosting()) return;
  if (!currentPollId) return;
  const user = evt && evt.content && evt.content.user;
  if (!user || !user.id) return;

  // send activate-poll only to the new user
  var activateMsg = new CustomEvent('send');
  activateMsg.content = {
    sender: 'poll-control',
    recipient: user.id,
    type: 'activate-poll',
    pollId: currentPollId
  };
  document.dispatchEvent(activateMsg);

  // also send current results and voter counts (if we have them)
  const idx = getPollIndex(currentPollId);
  if (idx !== -1) {
    const poll = polls[idx];
    var resMsg = new CustomEvent('send');
    resMsg.content = {
      sender: 'poll-plugin',
      recipient: user.id,
      type: 'results',
      poll: poll.id,
      votes: poll.votes
    };
    document.dispatchEvent(resMsg);

    var votersMsg = new CustomEvent('send');
    votersMsg.content = {
      sender: 'poll-plugin',
      recipient: user.id,
      type: 'voters',
      poll: poll.id,
      voters: poll.voters
    };
    document.dispatchEvent(votersMsg);
  }
});

	Reveal.addEventListener('ready', function(){
//alert("READY");
		initializePolls();
	});

	return this;
};
