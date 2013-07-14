var Message = ProtectedShared.extend({
	base_url: '/messages',

	body_key: 'data',

	relations: {
		persona: {
			type: Composer.HasOne,
			model: 'Persona'
		}
	},

	public_fields: [
		'id',
		'to',
		'from',
		'keys'
	],

	private_fields: [
		'conversation_id',
		'subject',
		'body'
	],

	init: function()
	{
		// NOTE: although the persona is not serialized with the message, not
		// having a persona key will break message serialization anyway. this is
		// hard to get around, so we add a little hack here.
		this.get('persona').key	=	tcrypt.random_key();

		// keep the "created" timestamp updated (not that the ID changes, but w/e)
		this.bind('change:id', function() {
			var id		=	this.id(true);
			if(!id) return;
			var ts		=	parseInt(this.id().substr(0, 8), 16);
			if(!ts) return;
			var date	=	new Date(ts * 1000);
			this.set({created: date});
		}.bind(this), 'message:track_timestamp');
		this.trigger('change:id');
	}
});

var Messages = Composer.Collection.extend({
	model: 'Message',

	conversations: null,

	last_id: null,

	sortfn: function(a, b) { return a.id().localeCompare(b.id()); },

	init: function()
	{
		this.conversations = new Conversations();
		this.bind('add', function(model) {
			var conversation_id = model.get('conversation_id');
			if(!conversation_id) return;

			var conversation = this.conversations.find_by_id(conversation_id);
			if(conversation) return;

			// if a conversation doesn't exist for this message, create one and
			// add to the conversations list
			conversation = new Conversation({id: conversation_id})
			this.conversations.upsert(conversation, {silent: true});
		}.bind(this), 'messages:monitor_conversations:add');

		// track the last (greatest) ID of the synced messages
		this.bind('add', function(model) {
			this.last_id = this.last().id();
		}.bind(this), 'messages:track_last_id')
	},

	get_messages_for_persona: function(persona, challenge, options)
	{
		options || (options = {});
		if(!options.after)
		{
			var last = this.models().filter(function() { return true; }).sort(function(a, b) {
				return a.id().localeCompare(b.id());
			})[0];
			if(last) options.after = last.id();
		}

		var challenge_expired = function() {
			// We got a 403, try regenerating the persona challenge and sending
			// the request again with the new challenge
			persona.get_challenge({
				expire: 1800,   // 1/2 hour
				persist: true,
				success: function(challenge) {
					// mark this next request as a retry so it knows not to try
					// again on failure
					options.retry = true;
					this.get_messages_for_persona(persona, challenge, options);
				}.bind(this),
				error: function(err, xhr) {
					if(options.error) options.error(err, xhr);
				}.bind(this)
			});
		}.bind(this);

		if(!challenge)
		{
			challenge_expired();
			return false;
		}

		var response = persona.generate_response(challenge);
		tagit.api.get('/messages/personas/'+persona.id(), { after: options.after, challenge: response }, {
			success: function(res) {
				var my_personas	=	tagit.user.get('personas');
				this.add(res.received);
				this.add(res.sent.map(function(sent) {
					var persona		=	my_personas.find_by_id(sent.from);
					if(!persona) return false;
					sent.persona	=	persona.toJSON();
					return sent;
				}));
				if(options.success) options.success(res);
			}.bind(this),
			error: function(err, xhr) {
				if(xhr.status == 403 && !options.retry)
				{
					challenge_expired();
				}
				else
				{
					if(options.error) options.error(err, xhr);
				}
			}.bind(this)
		});
	},

	send: function(from_persona, challenge, to_persona, body, options)
	{
		options || (options = {});
	},

	sync: function(options)
	{
		options || (options = {});
		tagit.user.get('personas').each(function(persona) {
			this.get_messages_for_persona(persona, persona.challenge, {
				after: this.last_id,
				success: options.success,
				error: function(err, xhr) {
					barfr.barf('There was a problem grabbing messages from your persona '+persona.get('screenname')+': '+ err);
					if(options.error) options.error();
				}.bind(this)
			});
		}.bind(this));
	}
});

var MessagesFilterConversation = Composer.FilterCollection.extend({
	sortfn: function(a, b)
	{
		return a.id().localeCompare(b.id());
	},

	filter: function(msg, collection)
	{
		var conversation = collection.get_parent();
		return msg.get('conversation_id') == conversation.id();
	}
});
