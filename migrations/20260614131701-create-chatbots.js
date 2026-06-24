export async function up(queryInterface, Sequelize) {
  await queryInterface.createTable('chatbots', {
    chatbotId: {
      type: Sequelize.UUID,
      defaultValue: Sequelize.UUIDV4,
      primaryKey: true,
    },

    slug: {
      type: Sequelize.STRING,
      allowNull: false,
      unique: true,
    },

    name: {
      type: Sequelize.STRING,
      allowNull: false,
    },

    systemPrompt: {
      type: Sequelize.TEXT,
      allowNull: false,
    },

    createdBy: {
      type: Sequelize.UUID,
      allowNull: false,
      references: {
        model: 'users',
        key: 'userId',
      },
      onDelete: 'CASCADE',
    },

    createdAt: {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
    },

    updatedAt: {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
    },
  });

  // Index on slug — looked up on every single request
  await queryInterface.addIndex('chatbots', ['slug'], {
    unique: true,
    name: 'chatbots_slug_unique',
  });
}

export async function down(queryInterface) {
  await queryInterface.dropTable('chatbots');
}